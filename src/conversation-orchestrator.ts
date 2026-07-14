import { buildRepoManifest } from "./architect/repo-manifest";
import { startArchitectSession, type ArchitectSession } from "./architect/claude-session";
import type { GitRunner } from "./builder/codex-driver";
import type { BuilderRunSettings } from "./run-builder";
import type { ApprovalVerdict, DaemonAgentPayload, HandoffResult } from "./domain";
import type { ArchitectEffort, BuilderEffort } from "./effort";
import { isTestDelta } from "./shared/test-delta-shape";
import { PlanForgeError } from "./errors";
import { buildChangeDiff, mergeFastForward, removeBuilderWorktree } from "./git-operations";
import type { ConversationStore, TranscriptEntryType } from "./conversation-store";
import { isJsonObject, type JsonObject, type JsonValue } from "./shared/json";
import type { ChatRun, ChatRunService, SseClient } from "./run-service";
import type { PlanForgeRegistry, RunBuilder } from "./registry";
import { removeRunMcpConfig, sweepRunResidue } from "./runtime-residue";
import type { PlanForgeLoopConfig } from "./loop-config";
import type { NotifyHook, NotifyPayload } from "./notify-hook";

export type ArchitectSessionStarter = typeof startArchitectSession;
export type BuildConversationalPrompt = typeof buildConversationalArchitectPrompt;
export type WriteMcpConfig = (input: { readonly runtimeRoot: string; readonly runId: string }) => Promise<string>;
export type TimerHandle = { unref?: () => void };
export type SetTimer = (fn: () => void, ms: number) => TimerHandle;
export type ClearTimer = (handle: TimerHandle) => void;
// Shared runId -> live MCP transports map, populated by the single-process handler when an
// architect session initializes with ?runId, and drained here at teardown so a reaped session's
// transport is closed even when the client never sends the spec DELETE.
export type CloseableMcpTransport = { close(): Promise<void> };
export type McpSessionStore = Map<string, Set<CloseableMcpTransport>>;

export type CreateConversationOrchestratorInput = {
  readonly store: ConversationStore;
  readonly runService: ChatRunService;
  readonly registry: PlanForgeRegistry;
  readonly runBuilder: RunBuilder;
  readonly loopConfig: PlanForgeLoopConfig;
  readonly startSession?: ArchitectSessionStarter;
  readonly writeMcpConfig?: WriteMcpConfig;
  readonly buildPrompt?: BuildConversationalPrompt;
  readonly git?: GitRunner;
  readonly now?: () => number;
  readonly idleTimeoutMs?: number;
  readonly setTimer?: SetTimer;
  readonly clearTimer?: ClearTimer;
  // Optional shared map (runId -> resolved targetRepo) the orchestrator populates when a
  // conversation run starts, so the run-builder and the read_repo_file MCP tool — which only see a
  // runId — can build into / read from THIS conversation's target instead of the server default.
  readonly targetRepoStore?: Map<string, string>;
  readonly runSettingsStore?: Map<string, BuilderRunSettings>;
  // Optional shared map (runId -> live MCP transports) the single-process handler populates; the
  // orchestrator closes and drains a run's entry on teardown so its transports never leak.
  readonly mcpSessions?: McpSessionStore;
  readonly notifyHook?: NotifyHook;
};

export type ConversationOrchestrator = {
  startRun(conversationId: string): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  approve(conversationId: string, verdict: ApprovalVerdict, feedback?: string): void;
  stop(conversationId: string): Promise<void>;
};

type BuildConversationalArchitectPromptInput = {
  readonly runId: string;
  readonly loopConfig: PlanForgeLoopConfig;
  readonly repoManifest: string;
  // Per-conversation target override. When set, this conversation builds in this repo instead of the
  // server-configured loopConfig.targetRepo. Falls back to loopConfig.targetRepo for legacy runs.
  readonly targetRepo?: string;
};

type LiveConversation = {
  readonly conversationId: string;
  readonly run: ChatRun;
  session: ArchitectSession | null;
  unsubscribe: () => void;
  queue: Promise<void>;
  pendingText: string;
  pendingGrade?: string;
  // Whether the architect acknowledged weakened test coverage on the sign_off that armed this cycle.
  // Surfaced on cycle_complete so the operator sees that a weakening was consciously accepted.
  pendingAckTestChanges: boolean;
  cycleReady: boolean;
  idleTimer: TimerHandle | null;
  buildInFlight: boolean;
  recoveryNudged: boolean;
  // The run's on-disk .mcp.json path, deleted at teardown so per-run runtime residue is not left
  // behind for process (and boot-persistent service) life.
  mcpConfigPath: string | null;
  // Per-run architect totals accumulated from each `usage` event, surfaced at cycle completion so
  // the operator can see how many tokens/time the architect side spent. The builder side emits no
  // parsed token usage (Codex output is streamed unparsed), but its build wall-clock + effort are
  // captured from the `build_usage` event and surfaced so BOTH sides are represented in the showcase.
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  // Builder-side spend captured from the `build_usage` run event.
  buildDurationMs: number;
  architectEffort: ArchitectEffort | null;
  builderEffort: BuilderEffort | null;
  buildEffort: string | null;
  buildModel: string | null;
  // The resolved target repo for this conversation: the conversation's own targetRepo, or the server
  // default (loopConfig.targetRepo) for legacy conversations that predate per-conversation targets.
  targetRepo: string;
  title: string;
};

function stringField(value: JsonObject, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function messageFromThrown(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

// Round a USD cost to 4 decimals so accumulated float drift (many tiny per-turn costs summed) does
// not produce noisy trailing digits in the displayed total.
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function messageFromRunError(data: JsonValue): string {
  if (isJsonObject(data)) {
    const message = stringField(data, "message");
    if (message) {
      return message;
    }
  }
  if (typeof data === "string") {
    return data;
  }
  return JSON.stringify(data);
}

function missingConversationError(conversationId: string): PlanForgeError {
  return new PlanForgeError("E_CONVERSATION_NOT_FOUND", `Conversation ${conversationId} was not found.`);
}

function noLiveRunError(conversationId: string): PlanForgeError {
  return new PlanForgeError("E_NO_LIVE_RUN", `Conversation ${conversationId} has no live architect run.`);
}

function missingMcpConfigProvider(): Promise<string> {
  return Promise.reject(
    new PlanForgeError(
      "E_MCP_CONFIG_PROVIDER_MISSING",
      "A conversation MCP config provider is required until the HTTP server supplies its resolved port."
    )
  );
}

function defaultSetTimer(fn: () => void, ms: number): TimerHandle {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return handle;
}

function defaultClearTimer(handle: TimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function asAgentPayload(data: JsonValue): DaemonAgentPayload | null {
  if (!isJsonObject(data)) {
    return null;
  }
  const type = stringField(data, "type");
  switch (type) {
    case "status": {
      const label = stringField(data, "label");
      if (!label) {
        return null;
      }
      // Preserve the model + ttftMs Claude reports on its init/status line so the operator can see
      // which model is actually driving the architect side (it is otherwise dropped on the floor).
      const model = stringField(data, "model");
      return model ? { type, label, model } : { type, label };
    }
    case "text_delta": {
      const delta = stringField(data, "delta");
      return delta === null ? null : { type, delta };
    }
    case "thinking_delta": {
      const delta = stringField(data, "delta");
      return delta === null ? null : { type, delta };
    }
    case "thinking_start":
      return { type };
    case "tool_use": {
      const id = stringField(data, "id");
      const name = stringField(data, "name");
      return id && name && data.input !== undefined ? { type, id, name, input: data.input } : null;
    }
    case "tool_result": {
      const toolUseId = stringField(data, "toolUseId");
      const content = stringField(data, "content");
      const isError = data.isError;
      if (!toolUseId || content === null) {
        return null;
      }
      return typeof isError === "boolean" ? { type, toolUseId, content, isError } : { type, toolUseId, content };
    }
    case "usage": {
      // Preserve the per-turn usage Claude reports (input/output tokens, cost, duration). The
      // orchestrator accumulates these per run and emits a summary so the operator can see the
      // spend; without this the whole usage object was discarded at the boundary.
      const usage = isJsonObject(data.usage) ? data.usage : undefined;
      const tokenUsage =
        usage &&
        (typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number")
          ? {
              ...(typeof usage.input_tokens === "number" ? { input_tokens: usage.input_tokens } : {}),
              ...(typeof usage.output_tokens === "number" ? { output_tokens: usage.output_tokens } : {})
            }
          : undefined;
      const costUsd = typeof data.costUsd === "number" ? data.costUsd : undefined;
      const durationMs = typeof data.durationMs === "number" ? data.durationMs : undefined;
      return {
        type,
        ...(tokenUsage ? { usage: tokenUsage } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(durationMs !== undefined ? { durationMs } : {})
      };
    }
    case "raw": {
      const line = stringField(data, "line");
      return line === null ? null : { type, line };
    }
    default:
      return null;
  }
}

function isPassingVerifierResult(data: JsonValue): boolean {
  return isJsonObject(data) && stringField(data, "status") === "pass";
}

function changeDiffSummary(stat: string): JsonObject {
  const summary: Record<string, JsonValue> = { files: 0, insertions: 0, deletions: 0 };
  const line = stat
    .split("\n")
    .map((part) => part.trim())
    .find((part) => /\bfiles? changed\b/.test(part));
  if (!line) {
    return summary;
  }
  const files = line.match(/(\d+)\s+files?\s+changed/);
  const insertions = line.match(/(\d+)\s+insertions?\(\+\)/);
  const deletions = line.match(/(\d+)\s+deletions?\(-\)/);
  if (files) {
    summary.files = Number(files[1] ?? 0);
  }
  if (insertions) {
    summary.insertions = Number(insertions[1] ?? 0);
  }
  if (deletions) {
    summary.deletions = Number(deletions[1] ?? 0);
  }
  return summary;
}

export function buildBuildRecoveryPrompt(input: { readonly runId: string; readonly handoffResult: HandoffResult }): string {
  const verifierSummary = input.handoffResult.verifierResults
    .map((result) => `  - ${result.name}: ${result.status}`)
    .join("\n");
  return [
    `Recovery notice for run ${input.runId}: your previous handoff_to_codex result was lost in transport, but the build completed and is durable.`,
    `Independent verifier status: ${input.handoffResult.status}.`,
    verifierSummary.length > 0 ? `Verifier results:\n${verifierSummary}` : "",
    "Do NOT call mcp__planforge__handoff_to_codex again — the build already ran.",
    "If the build meets the acceptance criteria, grade it and call mcp__planforge__sign_off with this exact runId.",
    "If it does not, revise the plan and call mcp__planforge__propose_plan again with the same runId."
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function buildConversationalArchitectPrompt(input: BuildConversationalArchitectPromptInput): string {
  const repoManifestSection =
    input.repoManifest.length > 0
      ? ["Repository context (read-only, for planning):", ...input.repoManifest.split("\n").map((line) => `  ${line}`)]
      : [];
  return [
    "You are the PlanForge Architect in an ongoing conversation with the operator.",
    `Run ID: ${input.runId}`,
    `Target repo: ${input.targetRepo ?? input.loopConfig.targetRepo}`,
    ...repoManifestSection,
    "Discuss the operator's request and clarify scope before building when needed.",
    "You may call mcp__planforge__read_repo_file with { runId, path } to read git-tracked files from the target repo.",
    "When the operator approves building something, call mcp__planforge__propose_plan with this exact runId and await the verdict.",
    "If the verdict is changes_requested, revise the plan and call mcp__planforge__propose_plan again with the same runId.",
    "Only after an approved verdict, call mcp__planforge__handoff_to_codex.",
    "When the verifier passes, call mcp__planforge__sign_off with your grade.",
    "If a build's test_delta shows weakening, you MUST review the actual test diff (read the build's changed test files) before sign_off. Reject or request changes if coverage was genuinely weakened without cause; only if the change is legitimate (e.g. a test updated to match an intended behavior change) call sign_off with acknowledgeTestChanges:true and state in your grade WHY the weakening is justified. Never blanket-acknowledge just to clear the gate.",
    "After sign_off, briefly summarize what was built and wait for the operator's next message.",
    "Do not exit, do not invent a runId, do not edit files directly, and do not start another plan unprompted."
  ].join("\n");
}

export function createConversationOrchestrator(input: CreateConversationOrchestratorInput): ConversationOrchestrator {
  const store = input.store;
  const runService = input.runService;
  const registry = input.registry;
  const loopConfig = input.loopConfig;
  const startSession = input.startSession ?? startArchitectSession;
  const buildPrompt = input.buildPrompt ?? buildConversationalArchitectPrompt;
  const writeMcpConfig = input.writeMcpConfig ?? missingMcpConfigProvider;
  const idleTimeoutMs = input.idleTimeoutMs ?? 600_000;
  const setTimer = input.setTimer ?? defaultSetTimer;
  const clearTimer = input.clearTimer ?? defaultClearTimer;
  const targetRepoStore = input.targetRepoStore;
  const runSettingsStore = input.runSettingsStore;
  const mcpSessions = input.mcpSessions;
  const liveConversations = new Map<string, LiveConversation>();
  const startingConversations = new Map<string, Promise<void>>();
  let residueSweepInFlight = false;

  // Opportunistic, bounded TTL sweep of runs/<runId> residue (events.jsonl + last-message.txt) at
  // conversation start. Fire-and-forget: a slow or failing sweep must never delay or fail a start.
  function sweepResidueOpportunistically(): void {
    if (residueSweepInFlight) {
      return;
    }
    residueSweepInFlight = true;
    void sweepRunResidue({ runtimeRoot: loopConfig.runtimeRoot })
      .catch(() => undefined)
      .finally(() => {
        residueSweepInFlight = false;
      });
  }

  // Close every MCP transport the handler registered for this run. Without this, a reaped or
  // stopped architect leaks its transport for process life (onclose only fires on a client DELETE
  // the claude CLI never sends).
  function closeMcpSessions(runId: string): void {
    const sessions = mcpSessions?.get(runId);
    if (!sessions) {
      return;
    }
    mcpSessions?.delete(runId);
    for (const session of sessions) {
      void session.close().catch(() => undefined);
    }
  }

  function discardMcpConfig(state: LiveConversation): void {
    const configPath = state.mcpConfigPath;
    if (!configPath) {
      return;
    }
    state.mcpConfigPath = null;
    void removeRunMcpConfig(configPath).catch(() => undefined);
  }

  function clearIdleTimer(state: LiveConversation): void {
    if (!state.idleTimer) {
      return;
    }
    clearTimer(state.idleTimer);
    state.idleTimer = null;
  }

  // A conversation reaped/stopped while its build PASSED but has not merged yet discards a verified
  // branch + worktree. Emit a distinct operator signal naming both so the orphaned verified build is
  // visible, instead of a silent discard. Fires only on a still-pass-but-unmerged handoff result.
  function surfaceOrphanedVerifiedBuild(state: LiveConversation): void {
    const handoffResult = registry.handoffResultFor(state.run.id);
    if (handoffResult?.status !== "pass" || !handoffResult.branch || !handoffResult.worktreePath) {
      return;
    }
    // A completed cycle's result stays in the registry until evict; a merged build is not orphaned.
    if (handoffResult.merged) {
      return;
    }
    const message = `Verified-but-unmerged build orphaned on teardown: branch ${handoffResult.branch} and worktree ${handoffResult.worktreePath} passed verification but were discarded without merging.`;
    console.warn(message);
    enqueueAppend(state, "error", { message });
  }

  // Transport-drop recovery: the architect's handoff_to_codex MCP call is held open for the whole
  // multi-minute build; if that long POST drops, the architect loses the result and its turn ends
  // WITHOUT a sign_off, orphaning a verified build. The build is durable in the registry, so on a
  // turn-end (usage) carrying a verified-but-unsigned passing build, re-prompt the still-alive
  // session ONCE with the result. The handoff is idempotent, so the build is never re-run; and the
  // architect still grades and signs off (hard rule #2 — the architect decides done).
  async function maybeRecoverUnsignedBuild(state: LiveConversation): Promise<void> {
    // pendingGrade set means the architect already graded (a merge_blocked keep-and-park, not a
    // drop): that has its own re-sign recovery, so leave it alone.
    if (state.recoveryNudged || !state.cycleReady || state.pendingGrade !== undefined) {
      return;
    }
    const handoffResult = registry.handoffResultFor(state.run.id);
    if (handoffResult?.status !== "pass") {
      return;
    }
    if (liveConversations.get(state.conversationId) !== state || !state.session) {
      return;
    }
    state.recoveryNudged = true;
    try {
      state.session.send(buildBuildRecoveryPrompt({ runId: state.run.id, handoffResult }));
    } catch {
      // The session closed between the turn-end and this send; the teardown orphan path surfaces it.
      return;
    }
    const data: JsonObject = handoffResult.branch
      ? {
          message: `Build for run ${state.run.id} passed verification but no sign-off was received (handoff result likely lost in transport). Re-prompted the architect to grade and sign off.`,
          runId: state.run.id,
          branch: handoffResult.branch
        }
      : {
          message: `Build for run ${state.run.id} passed verification but no sign-off was received (handoff result likely lost in transport). Re-prompted the architect to grade and sign off.`,
          runId: state.run.id
        };
    await appendOrDrop(state.conversationId, "recovery", data);
  }

  async function teardownState(state: LiveConversation, waitForDone: boolean): Promise<void> {
    if (liveConversations.get(state.conversationId) !== state) {
      return;
    }
    liveConversations.delete(state.conversationId);
    clearIdleTimer(state);
    if (targetRepoStore) {
      targetRepoStore.delete(state.run.id);
    }
    if (runSettingsStore) {
      runSettingsStore.delete(state.run.id);
    }
    // Settle the conversation run to a terminal status and drop its registry state so the run map
    // and the registry's handoff/verifier/approval maps do not leak per the conversation lifetime.
    // evict() also rejects any approval the architect is still awaiting, so its MCP call fails fast
    // instead of hanging once we tear the session down (idle reap / stop / architect crash).
    runService.cancel(state.run);
    // Before evicting, surface a distinct operator signal when we are about to discard a build that
    // already PASSED but never merged (verified-but-unmerged). Otherwise the verified branch and
    // worktree vanish silently on idle reap; the operator needs to know one is orphaned.
    surfaceOrphanedVerifiedBuild(state);
    registry.evict(state.run.id);
    closeMcpSessions(state.run.id);
    discardMcpConfig(state);
    state.unsubscribe();
    const session = state.session;
    session?.end();
    if (waitForDone) {
      await session?.done.catch(() => undefined);
      await state.queue;
    }
  }

  function resetIdleTimer(state: LiveConversation): void {
    if (liveConversations.get(state.conversationId) !== state) {
      return;
    }
    clearIdleTimer(state);
    // An in-flight Codex build can legitimately run to the build wall while the architect is
    // silent. Leave the reaper paused (no armed timer) until the build reaches a terminal outcome.
    if (state.buildInFlight) {
      return;
    }
    state.idleTimer = setTimer(() => {
      void teardownState(state, false);
    }, idleTimeoutMs);
  }

  function markBuildStarted(state: LiveConversation): void {
    if (state.buildInFlight) {
      return;
    }
    state.buildInFlight = true;
    // Each real build gets one transport-drop recovery nudge; reset the budget at its start. A
    // re-issued identical handoff JOINS the in-flight build (no new codex_stream), so this fires
    // once per genuine build, not per retry.
    state.recoveryNudged = false;
    // Pause reaping: a build can outlast the architect-idle timeout without the conversation
    // being stuck. Tearing it down here would kill the build and orphan the verified result.
    clearIdleTimer(state);
  }

  function markBuildSettled(state: LiveConversation): void {
    if (!state.buildInFlight) {
      return;
    }
    state.buildInFlight = false;
    // Resume reaping now that the build reached a terminal outcome; a genuinely stuck architect
    // with no build in flight is reaped on the normal idle timeout from here.
    resetIdleTimer(state);
  }

  function dropStateAfterDone(state: LiveConversation): void {
    if (liveConversations.get(state.conversationId) !== state) {
      return;
    }
    liveConversations.delete(state.conversationId);
    clearIdleTimer(state);
    if (targetRepoStore) {
      targetRepoStore.delete(state.run.id);
    }
    if (runSettingsStore) {
      runSettingsStore.delete(state.run.id);
    }
    // The architect session ended on its own; settle the run terminal and evict its registry state
    // so the run/registry maps do not accumulate once the conversation is no longer live.
    runService.cancel(state.run);
    registry.evict(state.run.id);
    closeMcpSessions(state.run.id);
    discardMcpConfig(state);
    state.unsubscribe();
  }

  async function appendOrDrop(conversationId: string, type: TranscriptEntryType, data: JsonObject): Promise<void> {
    try {
      await store.append(conversationId, type, data);
    } catch {
      return;
    }
  }

  async function flushPendingText(state: LiveConversation): Promise<void> {
    if (state.pendingText.length === 0) {
      return;
    }
    const text = state.pendingText;
    state.pendingText = "";
    await store.append(state.conversationId, "architect_message", { text });
  }

  function enqueueBridgeTask(state: LiveConversation, task: () => Promise<void>): void {
    const runTask = async () => {
      try {
        await task();
      } catch (error) {
        await appendOrDrop(state.conversationId, "error", {
          message: messageFromThrown(error instanceof Error ? error : String(error))
        });
      }
    };
    state.queue = state.queue.then(runTask, runTask);
  }

  function enqueueAppend(state: LiveConversation, type: TranscriptEntryType, data: JsonObject): void {
    enqueueBridgeTask(state, async () => {
      await store.append(state.conversationId, type, data);
    });
  }

  async function handleAgentEvent(state: LiveConversation, payload: DaemonAgentPayload): Promise<void> {
    switch (payload.type) {
      case "text_delta":
        state.pendingText += payload.delta;
        return;
      case "tool_use":
        await flushPendingText(state);
        await store.append(state.conversationId, "tool_use", { name: payload.name, input: payload.input });
        return;
      case "tool_result":
        await store.append(state.conversationId, "tool_result", {
          content: payload.content,
          isError: payload.isError ?? false
        });
        return;
      case "thinking_start":
      case "thinking_delta":
        await flushPendingText(state);
        return;
      case "usage": {
        // A claude `result` line ends the architect's turn. A turn that ends with a verified-but-
        // unsigned passing build is the transport-drop signature (a healthy long build keeps the
        // handoff tool call outstanding, so no usage fires mid-build). Recover it here.
        if (payload.usage) {
          state.inputTokens += payload.usage.input_tokens ?? 0;
          state.outputTokens += payload.usage.output_tokens ?? 0;
        }
        if (payload.costUsd !== undefined) {
          state.costUsd += payload.costUsd;
        }
        if (payload.durationMs !== undefined) {
          state.durationMs += payload.durationMs;
        }
        await flushPendingText(state);
        await maybeRecoverUnsignedBuild(state);
        return;
      }
      case "status":
        // Capture the model the architect reports on its init line so the operator can see it. Only
        // the first reported model is latched (a session does not switch models mid-run).
        if (payload.model && !state.model) {
          state.model = payload.model;
        }
        return;
      case "raw":
        return;
    }
  }

  async function runMergeWatcher(state: LiveConversation): Promise<void> {
    if (!state.cycleReady) {
      return;
    }
    const handoffResult = registry.handoffResultFor(state.run.id);
    if (!handoffResult?.branch || !handoffResult.worktreePath) {
      return;
    }
    state.cycleReady = false;
    try {
      await mergeFastForward({
        targetRepo: state.targetRepo,
        branch: handoffResult.branch,
        git: input.git
      });
    } catch (error) {
      // KEEP-AND-PARK: a verifier-passing build whose --ff-only merge was rejected (the target
      // advanced under us in a multi-writer estate) must not be discarded. Preserve the grade and
      // re-arm the cycle so a re-issued sign_off can retry the merge once the branch settles.
      state.cycleReady = true;
      const data: JsonObject = state.pendingGrade
        ? {
            branch: handoffResult.branch,
            grade: state.pendingGrade,
            reason: messageFromThrown(error instanceof Error ? error : String(error))
          }
        : {
            branch: handoffResult.branch,
            reason: messageFromThrown(error instanceof Error ? error : String(error))
          };
      await appendOrDrop(state.conversationId, "merge_blocked", data);
      return;
    }
    registry.markHandoffMerged(state.run.id);

    // The merge has already landed. A failure removing the now-merged worktree is a cleanup
    // warning, never merge_blocked — re-arming the cycle here would re-merge an applied branch.
    try {
      await removeBuilderWorktree({
        targetRepo: state.targetRepo,
        worktreePath: handoffResult.worktreePath,
        git: input.git
      });
    } catch (error) {
      await appendOrDrop(state.conversationId, "error", {
        message: `Merged ${handoffResult.branch}, but removing the build worktree at ${handoffResult.worktreePath} failed: ${messageFromThrown(
          error instanceof Error ? error : String(error)
        )}`
      });
    }

    const data: JsonObject = {
      branch: handoffResult.branch,
      ...(state.pendingGrade ? { grade: state.pendingGrade } : {}),
      // Record on the completed cycle that a weakened test change was consciously acknowledged, so the
      // audited decision is durable in the transcript alongside the grade it was signed off under.
      ...(state.pendingAckTestChanges ? { acknowledgedTestChanges: true } : {})
    };
    state.pendingGrade = undefined;
    state.pendingAckTestChanges = false;
    // The cycle's build is now merged and its worktree removed. Drop its build cache so the next
    // handoff — even one whose content is byte-identical to this just-merged cycle — rebuilds rather
    // than returning this stale, already-merged result.
    registry.clearBuildCache(state.run.id);
    await store.append(state.conversationId, "cycle_complete", data);
    notify(state, { event: "cycle_complete", state: "pass" });
    // At the end of the loop, surface BOTH sides' spend so the operator can see what the cycle took:
    // the architect (model + accumulated tokens + cost + turn time) and the builder (build wall-clock
    // + effort; the builder emits no parsed tokens). Both are real measurements — nothing is invented.
    await appendOrDrop(state.conversationId, "usage", usageSummary(state));
    await appendOrDrop(state.conversationId, "usage", builderUsageSummary(state));
  }

  function builderUsageSummary(state: LiveConversation): JsonObject {
    // The builder emits no token usage; surface the build wall-clock + effort (and the configured
    // model, if any) so the builder side is represented alongside the architect in the showcase.
    const usage: Record<string, JsonValue> = {
      side: "builder",
      durationMs: state.buildDurationMs
    };
    const effort = state.buildEffort ?? state.builderEffort;
    if (effort) {
      usage.effort = effort;
    }
    if (state.buildModel) {
      usage.model = state.buildModel;
    }
    return usage;
  }

  function usageSummary(state: LiveConversation): JsonObject {
    const usage: Record<string, JsonValue> = {
      side: "architect",
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      durationMs: state.durationMs
    };
    if (state.model) {
      usage.model = state.model;
    }
    if (state.architectEffort) {
      usage.effort = state.architectEffort;
    }
    if (state.costUsd > 0) {
      usage.costUsd = round4(state.costUsd);
    }
    return usage;
  }

  function notify(state: LiveConversation, payload: Omit<NotifyPayload, "conversationId" | "title" | "url">): void {
    input.notifyHook?.({
      event: payload.event,
      conversationId: state.conversationId,
      title: state.title,
      state: payload.state
    });
  }

  async function appendChangeDiff(state: LiveConversation, data: JsonObject): Promise<void> {
    const branch = stringField(data, "branch");
    const base = stringField(data, "base");
    if (!branch || !base) {
      return;
    }
    try {
      const diff = await buildChangeDiff({
        targetRepo: state.targetRepo,
        base,
        head: branch,
        git: input.git
      });
      await store.append(state.conversationId, "change_diff", {
        branch,
        base,
        stat: diff.stat,
        patch: diff.patch,
        truncated: diff.truncated,
        summary: changeDiffSummary(diff.stat)
      });
    } catch (error) {
      await appendOrDrop(state.conversationId, "change_diff", {
        branch,
        base,
        notice: `Could not generate builder diff: ${messageFromThrown(error instanceof Error ? error : String(error))}`
      });
    }
  }

  function handleRunEvent(state: LiveConversation, event: string, data: JsonValue): void {
    if (event === "agent") {
      resetIdleTimer(state);
    } else if (event === "codex_stream") {
      // First builder output marks the build in flight; pause the idle reaper for its duration.
      markBuildStarted(state);
    } else if (event === "verifier_result" || event === "error") {
      // Any terminal build outcome (pass/fail/blocked verifier or a build error) settles the build
      // and resumes idle reaping.
      markBuildSettled(state);
    }
    enqueueBridgeTask(state, async () => {
      switch (event) {
        case "agent": {
          const payload = asAgentPayload(data);
          if (payload) {
            await handleAgentEvent(state, payload);
          }
          return;
        }
        case "plan_proposed": {
          if (isJsonObject(data)) {
            const title = stringField(data, "title");
            const plan = stringField(data, "plan");
            if (title !== null && plan !== null) {
              await flushPendingText(state);
              await store.append(state.conversationId, "plan_proposed", { title, plan });
              notify(state, { event: "plan_awaiting_approval", state: "awaiting_approval" });
            }
          }
          return;
        }
        case "codex_stream": {
          if (isJsonObject(data)) {
            const chunk = stringField(data, "chunk");
            if (chunk !== null) {
              await store.append(state.conversationId, "build_output", { chunk });
            }
          }
          return;
        }
        case "test_delta": {
          // Deterministic diff of the build's test change against its base, emitted by run-builder
          // after a build produced a branch. Persist it as its own transcript entry so a weakened
          // (or clean) test change is durable and visible; detect-only — nothing gates on it yet.
          if (isJsonObject(data) && isTestDelta(data.testDelta)) {
            await store.append(state.conversationId, "test_delta", { testDelta: data.testDelta });
          }
          return;
        }
        case "verifier_result": {
          if (isJsonObject(data)) {
            const status = stringField(data, "status");
            const verifierResults = data.verifierResults ?? [];
            if (status !== null) {
              await store.append(state.conversationId, "verify_result", { status, verifierResults });
              await appendChangeDiff(state, data);
              if (isPassingVerifierResult(data)) {
                state.cycleReady = true;
              } else {
                notify(state, { event: "cycle_complete", state: status });
              }
            }
          }
          return;
        }
        case "architect_grade": {
          if (isJsonObject(data)) {
            const grade = stringField(data, "grade");
            if (grade !== null) {
              state.pendingGrade = grade;
            }
            state.pendingAckTestChanges = data.acknowledgeTestChanges === true;
          }
          return;
        }
        case "build_usage": {
          // Capture the builder-side spend (build wall-clock, optional effort + model) emitted by
          // run-builder after the build settles, so a builder `usage` entry can be surfaced at cycle
          // completion alongside the architect one.
          if (isJsonObject(data)) {
            const durationMs = data.durationMs;
            if (typeof durationMs === "number") {
              // The build can legitimately settle and emit before the sign_off re-arms the cycle; keep
              // the largest observed build time so a re-arm does not clobber a real measurement.
              state.buildDurationMs = Math.max(state.buildDurationMs, durationMs);
            }
            const effort = stringField(data, "effort");
            if (effort) {
              state.buildEffort = effort;
            }
            const buildModel = stringField(data, "model");
            if (buildModel) {
              state.buildModel = buildModel;
            }
          }
          return;
        }
        case "error":
          await store.append(state.conversationId, "error", { message: messageFromRunError(data) });
          return;
        case "sign_off":
          await runMergeWatcher(state);
          return;
        case "stderr":
        default:
          return;
      }
    });
  }

  async function startRunInternal(conversationId: string): Promise<void> {
    if (liveConversations.get(conversationId)?.session) {
      return;
    }
    const conversation = await store.get(conversationId);
    if (!conversation) {
      throw missingConversationError(conversationId);
    }
    sweepResidueOpportunistically();
    const run = runService.create({ conversationId });
    runService.markRunning(run);
    // Resolve this conversation's build target: its own allowlisted targetRepo, or the server
    // default for legacy conversations that predate per-conversation targets.
    const targetRepo = conversation.targetRepo ?? loopConfig.targetRepo;
    const architectEffort = conversation.architectEffort ?? loopConfig.architectEffort ?? null;
    const architectModel = conversation.architectModel ?? loopConfig.architectModel;
    const builderEffort = conversation.builderEffort ?? loopConfig.builderEffort ?? null;
    const builderModel = conversation.builderModel ?? loopConfig.builderModel;
    // Publish the resolved target keyed on runId so the run-builder + read_repo_file (which only see
    // the runId) build into / read from this conversation's target. Cleared on teardown.
    if (targetRepoStore) {
      targetRepoStore.set(run.id, targetRepo);
    }
    if (runSettingsStore) {
      runSettingsStore.set(run.id, {
        ...(builderEffort ? { builderEffort } : {}),
        ...(builderModel ? { builderModel } : {})
      });
    }
    const state: LiveConversation = {
      conversationId,
      run,
      targetRepo,
      title: conversation.title?.trim() || "Untitled conversation",
      session: null,
      unsubscribe: () => {},
      queue: Promise.resolve(),
      pendingText: "",
      pendingAckTestChanges: false,
      cycleReady: false,
      idleTimer: null,
      buildInFlight: false,
      recoveryNudged: false,
      mcpConfigPath: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      buildDurationMs: 0,
      architectEffort,
      builderEffort,
      buildEffort: null,
      buildModel: builderModel && builderModel !== "default" ? builderModel : null
    };
    const client: SseClient = {
      send(event, data) {
        handleRunEvent(state, event, data);
      },
      end() {},
      cleanup() {}
    };
    state.unsubscribe = runService.subscribe(run, client);
    liveConversations.set(conversationId, state);

    try {
      const repoManifest = await buildRepoManifest({ targetRepo: state.targetRepo, git: input.git });
      const mcpConfigPath = await writeMcpConfig({ runtimeRoot: loopConfig.runtimeRoot, runId: run.id });
      state.mcpConfigPath = mcpConfigPath;
      const session = startSession({
        sessionId: conversationId,
        resume: conversation.sessionStarted,
        mcpConfigPath,
        systemPrompt: buildPrompt({ runId: run.id, loopConfig, repoManifest, targetRepo: state.targetRepo }),
        ...(architectEffort ? { effort: architectEffort } : {}),
        ...(architectModel ? { model: architectModel } : {}),
        env: loopConfig.env,
        // Run the architect process IN the resolved target so its ambient context (CLAUDE.md, hooks)
        // is the target's, not PlanForge's own tree.
        cwd: state.targetRepo,
        onEvent: (event) => runService.emit(run, "agent", event),
        onStderr: (chunk) => runService.emit(run, "stderr", { chunk })
      });
      state.session = session;
      if (!conversation.sessionStarted) {
        await store.markSessionStarted(conversationId);
      }
      resetIdleTimer(state);
      session.done.then(
        () => {
          enqueueBridgeTask(state, async () => {
            await flushPendingText(state);
            dropStateAfterDone(state);
          });
        },
        (error: Error) => {
          enqueueBridgeTask(state, async () => {
            await flushPendingText(state);
            await appendOrDrop(conversationId, "error", { message: messageFromThrown(error) });
            dropStateAfterDone(state);
          });
        }
      );
    } catch (error) {
      await teardownState(state, true);
      throw error;
    }
  }

  async function startRun(conversationId: string): Promise<void> {
    if (liveConversations.get(conversationId)?.session) {
      return;
    }
    const pendingStart = startingConversations.get(conversationId);
    if (pendingStart) {
      await pendingStart;
      return;
    }
    const start = startRunInternal(conversationId);
    startingConversations.set(conversationId, start);
    try {
      await start;
    } finally {
      if (startingConversations.get(conversationId) === start) {
        startingConversations.delete(conversationId);
      }
    }
  }

  async function sendMessage(conversationId: string, text: string): Promise<void> {
    if (!liveConversations.get(conversationId)?.session) {
      await startRun(conversationId);
    }
    const state = liveConversations.get(conversationId);
    if (!state?.session) {
      throw noLiveRunError(conversationId);
    }
    await store.append(conversationId, "user_message", { text });
    state.session.send(text);
    resetIdleTimer(state);
  }

  function approve(conversationId: string, verdict: ApprovalVerdict, feedback?: string): void {
    const state = liveConversations.get(conversationId);
    if (!state) {
      throw noLiveRunError(conversationId);
    }
    registry.resolveApproval({
      runId: state.run.id,
      verdict,
      ...(feedback ? { feedback } : {})
    });
    enqueueAppend(state, "approval", feedback ? { verdict, feedback } : { verdict });
  }

  async function stop(conversationId: string): Promise<void> {
    const state = liveConversations.get(conversationId);
    if (!state) {
      return;
    }
    await teardownState(state, true);
  }

  return {
    startRun,
    sendMessage,
    approve,
    stop
  };
}
