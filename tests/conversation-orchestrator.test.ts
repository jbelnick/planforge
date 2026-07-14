import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StartArchitectSessionInput } from "../src/architect/claude-session";
import type { ClaudeSpawnResult } from "../src/architect/claude-driver";
import type { GitRunner } from "../src/builder/codex-driver";
import {
  createConversationOrchestrator,
  buildConversationalArchitectPrompt,
  type ArchitectSessionStarter,
  type McpSessionStore,
  type TimerHandle,
  type WriteMcpConfig
} from "../src/conversation-orchestrator";
import { RUN_RESIDUE_TTL_MS } from "../src/runtime-residue";
import { createConversationStore, type ConversationStore, type TranscriptEntry } from "../src/conversation-store";
import type { DaemonAgentPayload, HandoffResult, VerifierResult } from "../src/domain";
import { PlanForgeError } from "../src/errors";
import type { NotifyHook, NotifyPayload } from "../src/notify-hook";
import { createChatRunService, type ChatRun, type ChatRunService } from "../src/run-service";
import { createPlanForgeRegistry, type PlanForgeRegistry, type RunBuilder } from "../src/registry";
import { createPlanForgeToolHandlers, type PlanForgeToolHandlers } from "../src/tools";
import { stringField } from "../src/ui/chat-model";
import type { PlanForgeLoopConfig } from "../src/start-server";

const tempDirs: string[] = [];
const conversationId = "11111111-1111-4111-8111-111111111111";
const missingConversationId = "22222222-2222-4222-8222-222222222222";
const verifierResults: readonly VerifierResult[] = [{ name: "fake verifier", status: "pass", exitCode: 0, output: "ok" }];

type FakeSessionCall = {
  readonly input: StartArchitectSessionInput;
  readonly sends: string[];
  ended: boolean;
  resolveDone(result: ClaudeSpawnResult): void;
  rejectDone(error: Error): void;
};

type FakeTimerHandle = TimerHandle & {
  readonly ms: number;
  active: boolean;
  fire(): void;
};

type FakeTimers = {
  readonly handles: readonly FakeTimerHandle[];
  readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer: (handle: TimerHandle) => void;
  latest(): FakeTimerHandle;
};

type Harness = {
  readonly root: string;
  readonly store: ConversationStore;
  readonly runService: ChatRunService;
  readonly registry: PlanForgeRegistry;
  readonly tools: PlanForgeToolHandlers;
  readonly orchestrator: ReturnType<typeof createConversationOrchestrator>;
  readonly sessionCalls: FakeSessionCall[];
  readonly gitCalls: readonly string[][];
  readonly loopConfig: PlanForgeLoopConfig;
  readonly timers: FakeTimers;
  readonly notifications: readonly Omit<NotifyPayload, "url">[];
};

afterEach(async () => {
  // Retried removal: a test returns as soon as the transcript shows its marker entry, but the
  // orchestrator bridge may still be appending trailing entries (usage summaries land after
  // cycle_complete), and an in-flight append can recreate a file mid-delete → ENOTEMPTY. Node's
  // recursive rm re-scans on retry, absorbing those last writes.
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })));
  tempDirs.length = 0;
});

function runIdFor(index: number): string {
  return `run-conversation-${index}`;
}

function branchFor(runId: string): string {
  return `planforge/${runId}`;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-conversation-orchestrator-"));
  tempDirs.push(root);
  return root;
}

function createFakeTimers(): FakeTimers {
  const handles: FakeTimerHandle[] = [];
  return {
    handles,
    setTimer(fn, ms) {
      const handle: FakeTimerHandle = {
        ms,
        active: true,
        unref() {},
        fire() {
          if (!handle.active) {
            return;
          }
          handle.active = false;
          fn();
        }
      };
      handles.push(handle);
      return handle;
    },
    clearTimer(handle) {
      const timer = handles.find((candidate) => candidate === handle);
      if (timer) {
        timer.active = false;
      }
    },
    latest() {
      const handle = handles.at(-1);
      if (!handle) {
        throw new Error("Expected a fake idle timer.");
      }
      return handle;
    }
  };
}

function makeFakeStartSession(
  calls: FakeSessionCall[],
  options: { readonly deferDoneOnEnd?: boolean } = {}
): ArchitectSessionStarter {
  return (input) => {
    let resolveDone: (result: ClaudeSpawnResult) => void = () => {};
    let rejectDone: (error: Error) => void = () => {};
    const done = new Promise<ClaudeSpawnResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const call: FakeSessionCall = {
      input,
      sends: [],
      ended: false,
      resolveDone,
      rejectDone
    };
    calls.push(call);
    return {
      send(text) {
        call.sends.push(text);
      },
      end() {
        call.ended = true;
        if (!options.deferDoneOnEnd) {
          resolveDone({ exitCode: 0, signal: null });
        }
      },
      done
    };
  };
}

function latestRun(runService: ChatRunService): ChatRun {
  const run = runService.list().at(-1);
  if (!run) {
    throw new PlanForgeError("E_TEST_RUN_MISSING", "Expected a fake run to exist.");
  }
  return run;
}

function currentSession(harness: Harness): FakeSessionCall {
  const session = harness.sessionCalls.at(-1);
  if (!session) {
    throw new Error("Expected a fake architect session.");
  }
  return session;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForGone(target: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!existsSync(target)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for removal: ${target}`);
}

async function waitForTranscript(
  store: ConversationStore,
  expected: (entries: readonly TranscriptEntry[]) => boolean
): Promise<TranscriptEntry[]> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const entries = await store.readTranscript(conversationId);
    if (expected(entries)) {
      return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for transcript.");
}

async function createHarness(
  input: {
    readonly git?: GitRunner;
    readonly deferDoneOnEnd?: boolean;
    readonly idleTimeoutMs?: number;
    readonly makeRunBuilder?: (deps: { readonly runService: ChatRunService; readonly loopConfig: PlanForgeLoopConfig }) => RunBuilder;
    // Optional per-conversation build target (allowlisted repo) to seed into the harness conversation.
    readonly conversationTargetRepo?: string;
    readonly writeMcpConfig?: WriteMcpConfig;
    readonly mcpSessions?: McpSessionStore;
    readonly notifyHook?: NotifyHook;
  } = {}
): Promise<Harness> {
  const root = await tempRoot();
  const store = createConversationStore({
    root: path.join(root, "conversations"),
    idFactory: () => conversationId
  });
  await store.create({
    title: "Conversation loop",
    ...(input.conversationTargetRepo ? { targetRepo: input.conversationTargetRepo } : {})
  });
  let nextRunIndex = 0;
  const runService = createChatRunService({
    idFactory: () => {
      nextRunIndex += 1;
      return runIdFor(nextRunIndex);
    }
  });
  const gitCalls: string[][] = [];
  const git: GitRunner =
    input.git ??
    (async (args) => {
      gitCalls.push([...args]);
      return { stdout: "", stderr: "" };
    });
  const loopConfig: PlanForgeLoopConfig = {
    targetRepo: path.join(root, "target"),
    runtimeRoot: path.join(root, "runtime"),
    env: { PATH: "/usr/bin" },
    verifierCommands: [{ name: "fake verifier", command: "npm test" }],
    architectEffort: "max"
  };
  const defaultRunBuilder: RunBuilder = async (handoff): Promise<HandoffResult> => {
    const run = runService.get(handoff.runId);
    if (!run) {
      throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${handoff.runId} was not found.`);
    }
    runService.emit(run, "codex_stream", { runId: handoff.runId, chunk: `builder output for ${handoff.objective}` });
    runService.emit(run, "verifier_result", {
      runId: handoff.runId,
      status: "pass",
      verifierResults,
      summary: "Verifier status: pass."
    });
    return {
      status: "pass",
      verifierResults,
      branch: branchFor(handoff.runId),
      worktreePath: path.join(loopConfig.runtimeRoot, "worktrees", handoff.runId)
    };
  };
  const runBuilder: RunBuilder = input.makeRunBuilder ? input.makeRunBuilder({ runService, loopConfig }) : defaultRunBuilder;
  const registry = createPlanForgeRegistry({ runBuilder });
  const tools = createPlanForgeToolHandlers({ registry, runService, loopConfig });
  const sessionCalls: FakeSessionCall[] = [];
  const notifications: Omit<NotifyPayload, "url">[] = [];
  const timers = createFakeTimers();
  const orchestrator = createConversationOrchestrator({
    store,
    runService,
    registry,
    runBuilder,
    loopConfig,
    startSession: makeFakeStartSession(sessionCalls, { deferDoneOnEnd: input.deferDoneOnEnd }),
    writeMcpConfig: input.writeMcpConfig ?? (async ({ runtimeRoot, runId }) => path.join(runtimeRoot, runId, "mcp.json")),
    git,
    idleTimeoutMs: input.idleTimeoutMs ?? 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...(input.mcpSessions ? { mcpSessions: input.mcpSessions } : {}),
    notifyHook: input.notifyHook ?? ((payload) => notifications.push(payload))
  });

  return {
    root,
    store,
    runService,
    registry,
    tools,
    orchestrator,
    sessionCalls,
    gitCalls,
    loopConfig,
    timers,
    notifications
  };
}

async function drivePassingCycle(
  harness: Harness,
  suffix: string,
  options: { readonly acknowledgeTestChanges?: boolean } = {}
): Promise<void> {
  const run = latestRun(harness.runService);
  const session = currentSession(harness);
  session.input.onEvent?.({ type: "text_delta", delta: `Architect response ${suffix}.` });
  session.input.onEvent?.({ type: "usage" });
  const approval = harness.tools.propose_plan({
    runId: run.id,
    title: `Plan ${suffix}`,
    plan: `Build ${suffix}.`
  });
  await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "plan_proposed"));
  harness.orchestrator.approve(conversationId, "approved");
  await approval;
  await harness.tools.handoff_to_codex({
    runId: run.id,
    project: "fake",
    objective: `Build ${suffix}`,
    context: "fake context",
    constraints: "fake constraints",
    verification: ["npm test"],
    stop_conditions: ["stop after sign_off"]
  });
  await harness.tools.sign_off({
    runId: run.id,
    verdict: "pass",
    grade: `Grade ${suffix}`,
    ...(options.acknowledgeTestChanges ? { acknowledgeTestChanges: true } : {})
  });
}

function mergeCallCount(gitCalls: readonly string[][]): number {
  return gitCalls.filter((args) => args.includes("merge")).length;
}

describe("Conversation orchestrator", () => {
  it("fires notify hooks when a plan awaits approval and when a passing cycle completes", async () => {
    const harness = await createHarness();
    await harness.orchestrator.sendMessage(conversationId, "please build");
    await drivePassingCycle(harness, "notify-pass");
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "cycle_complete"));

    expect(harness.notifications).toEqual([
      {
        event: "plan_awaiting_approval",
        conversationId,
        title: "Conversation loop",
        state: "awaiting_approval"
      },
      {
        event: "cycle_complete",
        conversationId,
        title: "Conversation loop",
        state: "pass"
      }
    ]);
  });

  it("fires a completion notify for failed verifier cycles without blocking the loop", async () => {
    const failVerifier: readonly VerifierResult[] = [{ name: "fake verifier", status: "fail", exitCode: 1, output: "no" }];
    const harness = await createHarness({
      makeRunBuilder: ({ runService }): RunBuilder =>
        async (handoff): Promise<HandoffResult> => {
          const run = runService.get(handoff.runId);
          if (!run) {
            throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${handoff.runId} was not found.`);
          }
          runService.emit(run, "codex_stream", { runId: handoff.runId, chunk: "builder output" });
          runService.emit(run, "verifier_result", {
            runId: handoff.runId,
            status: "fail",
            verifierResults: failVerifier,
            summary: "Verifier status: fail."
          });
          return { status: "fail", verifierResults: failVerifier, branch: branchFor(handoff.runId), worktreePath: "/tmp/worktree" };
        }
    });
    await harness.orchestrator.sendMessage(conversationId, "please build");
    const run = latestRun(harness.runService);
    const approval = harness.tools.propose_plan({ runId: run.id, title: "Plan", plan: "Build it." });
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "plan_proposed"));
    harness.orchestrator.approve(conversationId, "approved");
    await approval;

    const result = await harness.tools.handoff_to_codex({
      runId: run.id,
      project: "fake",
      objective: "Build fail",
      context: "fake context",
      constraints: "fake constraints",
      verification: ["npm test"],
      stop_conditions: ["stop after verifier"]
    });

    expect(result.status).toBe("fail");
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "verify_result"));
    expect(harness.notifications.map((payload) => payload.state)).toEqual(["awaiting_approval", "fail"]);
  });

  it("emits a capped change diff after verify and folds it into the completed cycle", async () => {
    const bigPatch = `diff --git a/file.ts b/file.ts\n${"x".repeat(70 * 1024)}`;
    const git: GitRunner = async (args) => {
      if (args.includes("--stat")) {
        return { stdout: " src/file.ts | 12 +++++++++---\n 1 file changed, 9 insertions(+), 3 deletions(-)\n", stderr: "" };
      }
      if (args.includes("--patch")) {
        return { stdout: bigPatch, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const harness = await createHarness({
      git,
      makeRunBuilder: ({ runService, loopConfig }): RunBuilder =>
        async (handoff): Promise<HandoffResult> => {
          const run = runService.get(handoff.runId);
          if (!run) {
            throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${handoff.runId} was not found.`);
          }
          const branch = branchFor(handoff.runId);
          runService.emit(run, "codex_stream", { runId: handoff.runId, chunk: "builder output" });
          runService.emit(run, "verifier_result", {
            runId: handoff.runId,
            status: "pass",
            verifierResults,
            summary: "Verifier status: pass.",
            branch,
            worktreePath: path.join(loopConfig.runtimeRoot, "worktrees", handoff.runId),
            base: "base-sha"
          });
          return {
            status: "pass",
            verifierResults,
            branch,
            worktreePath: path.join(loopConfig.runtimeRoot, "worktrees", handoff.runId),
            base: "base-sha"
          };
        }
    });
    await harness.orchestrator.sendMessage(conversationId, "please build");
    await drivePassingCycle(harness, "diff");

    const entries = await waitForTranscript(
      harness.store,
      (transcript) => transcript.some((entry) => entry.type === "change_diff") && transcript.some((entry) => entry.type === "cycle_complete")
    );
    const diff = entries.find((entry) => entry.type === "change_diff");
    expect(diff?.data.summary).toEqual({ files: 1, insertions: 9, deletions: 3 });
    expect(String(diff?.data.patch)).toContain("…truncated");
    expect(Buffer.byteLength(String(diff?.data.patch), "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(entries.map((entry) => entry.type).indexOf("change_diff")).toBeGreaterThan(entries.map((entry) => entry.type).indexOf("verify_result"));
  });

  it("records a change-diff notice when git diff generation fails", async () => {
    const git: GitRunner = async (args) => {
      if (args.includes("diff")) {
        throw new Error("diff unavailable");
      }
      return { stdout: "", stderr: "" };
    };
    const harness = await createHarness({
      git,
      makeRunBuilder: ({ runService, loopConfig }): RunBuilder =>
        async (handoff): Promise<HandoffResult> => {
          const run = runService.get(handoff.runId);
          if (!run) {
            throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${handoff.runId} was not found.`);
          }
          const branch = branchFor(handoff.runId);
          runService.emit(run, "verifier_result", {
            runId: handoff.runId,
            status: "pass",
            verifierResults,
            summary: "Verifier status: pass.",
            branch,
            worktreePath: path.join(loopConfig.runtimeRoot, "worktrees", handoff.runId),
            base: "base-sha"
          });
          return {
            status: "pass",
            verifierResults,
            branch,
            worktreePath: path.join(loopConfig.runtimeRoot, "worktrees", handoff.runId),
            base: "base-sha"
          };
        }
    });
    await harness.orchestrator.sendMessage(conversationId, "please build");
    await drivePassingCycle(harness, "diff-fail");

    const entries = await waitForTranscript(harness.store, (transcript) => transcript.some((entry) => entry.type === "change_diff"));
    expect(stringField(entries.find((entry) => entry.type === "change_diff")?.data ?? {}, "notice")).toContain(
      "Could not generate builder diff: diff unavailable"
    );
    expect(entries.some((entry) => entry.type === "cycle_complete")).toBe(true);
  });

  it("bridges a full live cycle into the durable transcript and runs the merge watcher", async () => {
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);

    await harness.orchestrator.sendMessage(conversationId, "build X");
    await drivePassingCycle(harness, "one");
    const entries = await waitForTranscript(
      harness.store,
      (transcript) => transcript.filter((entry) => entry.type === "cycle_complete").length === 1
    );

    expect(entries.map((entry) => entry.type)).toEqual([
      "user_message",
      "architect_message",
      "plan_proposed",
      "approval",
      "build_output",
      "verify_result",
      "cycle_complete",
      "usage",
      "usage"
    ]);
    expect(entries[0]?.data).toEqual({ text: "build X" });
    expect(entries[1]?.data).toEqual({ text: "Architect response one." });
    expect(entries.find((entry) => entry.type === "cycle_complete")?.data).toEqual({
      branch: branchFor(runIdFor(1)),
      grade: "Grade one"
    });
    // The end-of-loop showcase surfaces BOTH sides: the architect (accumulated tokens + turn time)
    // and the builder (build wall-clock). The fake harness emits a bare architect `{ type: "usage" }`
    // with no token/cost object (zeroed totals) and the builder carry an emitted build_usage of 0ms.
    const usages = entries.filter((entry) => entry.type === "usage").map((entry) => entry.data.side);
    expect(usages).toEqual(["architect", "builder"]);
    const architectUsage = entries.find((entry) => entry.type === "usage" && entry.data.side === "architect");
    expect(architectUsage?.data).toMatchObject({
      side: "architect",
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0
    });
    const builderUsage = entries.find((entry) => entry.type === "usage" && entry.data.side === "builder");
    expect(builderUsage?.data).toMatchObject({ side: "builder", durationMs: 0 });
    expect(harness.sessionCalls).toHaveLength(1);
    expect(harness.sessionCalls[0]?.input).toMatchObject({
      sessionId: conversationId,
      resume: false,
      mcpConfigPath: path.join(harness.loopConfig.runtimeRoot, runIdFor(1), "mcp.json"),
      effort: "max",
      env: { PATH: "/usr/bin" },
      // The architect runs in the resolved target (here the server default), not PlanForge's own tree.
      cwd: harness.loopConfig.targetRepo
    });
    expect(harness.sessionCalls[0]?.sends).toEqual(["build X"]);
    expect(mergeCallCount(harness.gitCalls)).toBe(1);
  });

  it("persists a test_delta run event as its own transcript entry, before the verifier result", async () => {
    // run-builder emits test_delta after a build produces a branch and before verify. The orchestrator
    // must bridge it into a durable test_delta transcript entry (detect-only — it never gates the cycle).
    const testDelta = {
      weakened: true,
      signals: ["deleted test file: tests/gone.test.ts", "added .only() in src/a.test.ts (disables sibling tests): 0 -> 1"],
      addedTests: 1,
      removedTests: 2,
      deletedTestFiles: ["tests/gone.test.ts"]
    };
    const harness = await createHarness({
      makeRunBuilder: ({ runService, loopConfig }) => async (handoff): Promise<HandoffResult> => {
        const run = runService.get(handoff.runId);
        if (!run) {
          throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${handoff.runId} was not found.`);
        }
        runService.emit(run, "codex_stream", { runId: handoff.runId, chunk: `builder output for ${handoff.objective}` });
        runService.emit(run, "test_delta", { runId: handoff.runId, testDelta });
        runService.emit(run, "verifier_result", {
          runId: handoff.runId,
          status: "pass",
          verifierResults,
          summary: "Verifier status: pass."
        });
        return {
          status: "pass",
          verifierResults,
          branch: branchFor(handoff.runId),
          worktreePath: path.join(loopConfig.runtimeRoot, "worktrees", handoff.runId),
          testDelta
        };
      }
    });
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build with a test delta");
    // The delta is weakened, so the cycle can only sign off WITH the acknowledgment.
    await drivePassingCycle(harness, "delta", { acknowledgeTestChanges: true });

    const entries = await waitForTranscript(
      harness.store,
      (transcript) => transcript.some((entry) => entry.type === "test_delta")
    );
    const deltaEntry = entries.find((entry) => entry.type === "test_delta");
    expect(deltaEntry?.data).toEqual({ testDelta });

    const order = entries.map((entry) => entry.type);
    expect(order.indexOf("test_delta")).toBeGreaterThan(order.indexOf("build_output"));
    expect(order.indexOf("test_delta")).toBeLessThan(order.indexOf("verify_result"));
  });

  it("ignores a malformed test_delta run event instead of persisting a bad entry", async () => {
    const harness = await createHarness({
      makeRunBuilder: ({ runService, loopConfig }) => async (handoff): Promise<HandoffResult> => {
        const run = runService.get(handoff.runId);
        if (!run) {
          throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${handoff.runId} was not found.`);
        }
        runService.emit(run, "codex_stream", { runId: handoff.runId, chunk: `builder output for ${handoff.objective}` });
        // A payload whose testDelta fails the shape guard (missing numeric fields) must be dropped.
        runService.emit(run, "test_delta", { runId: handoff.runId, testDelta: { weakened: "nope" } });
        runService.emit(run, "verifier_result", {
          runId: handoff.runId,
          status: "pass",
          verifierResults,
          summary: "Verifier status: pass."
        });
        return {
          status: "pass",
          verifierResults,
          branch: branchFor(handoff.runId),
          worktreePath: path.join(loopConfig.runtimeRoot, "worktrees", handoff.runId)
        };
      }
    });
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build with a bad test delta");
    await drivePassingCycle(harness, "baddelta");

    const entries = await waitForTranscript(
      harness.store,
      (transcript) => transcript.some((entry) => entry.type === "verify_result")
    );
    expect(entries.some((entry) => entry.type === "test_delta")).toBe(false);
  });

  it("does not merge a weakened build until an acknowledged sign_off arrives", async () => {
    // A build that weakened test coverage must not merge on an ordinary sign_off: the registry blocks
    // it (E_SIGN_OFF_BLOCKED naming the signals), so no verdict/merge happens. Only after the architect
    // reviews and re-signs with acknowledgeTestChanges does the cycle complete — and the transcript
    // records the acknowledgment on cycle_complete.
    const testDelta = {
      weakened: true,
      signals: ["deleted test file: tests/gone.test.ts"],
      addedTests: 0,
      removedTests: 1,
      deletedTestFiles: ["tests/gone.test.ts"]
    };
    const harness = await createHarness({
      makeRunBuilder: ({ runService, loopConfig }) => async (handoff): Promise<HandoffResult> => {
        const run = runService.get(handoff.runId);
        if (!run) {
          throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${handoff.runId} was not found.`);
        }
        runService.emit(run, "codex_stream", { runId: handoff.runId, chunk: `builder output for ${handoff.objective}` });
        runService.emit(run, "test_delta", { runId: handoff.runId, testDelta });
        runService.emit(run, "verifier_result", {
          runId: handoff.runId,
          status: "pass",
          verifierResults,
          summary: "Verifier status: pass."
        });
        return {
          status: "pass",
          verifierResults,
          branch: branchFor(handoff.runId),
          worktreePath: path.join(loopConfig.runtimeRoot, "worktrees", handoff.runId),
          testDelta
        };
      }
    });
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build that weakens tests");

    const run = latestRun(harness.runService);
    const session = currentSession(harness);
    session.input.onEvent?.({ type: "text_delta", delta: "Architect response weak." });
    session.input.onEvent?.({ type: "usage" });
    const approval = harness.tools.propose_plan({ runId: run.id, title: "Plan weak", plan: "Build weak." });
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "plan_proposed"));
    harness.orchestrator.approve(conversationId, "approved");
    await approval;
    await harness.tools.handoff_to_codex({
      runId: run.id,
      project: "fake",
      objective: "Build weak",
      context: "fake context",
      constraints: "fake constraints",
      verification: ["npm test"],
      stop_conditions: ["stop after sign_off"]
    });
    // The build passed the verifier and carried a weakened delta. An un-acknowledged sign_off is blocked.
    await expect(harness.tools.sign_off({ runId: run.id, verdict: "pass", grade: "Grade weak" })).rejects.toThrow(
      /weakened test coverage/
    );
    // Let the queue settle; no merge, no cycle completion off the blocked sign_off.
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "test_delta"));
    expect(mergeCallCount(harness.gitCalls)).toBe(0);
    let entries = await harness.store.readTranscript(conversationId);
    expect(entries.some((entry) => entry.type === "cycle_complete")).toBe(false);

    // The architect reviews and re-signs WITH the acknowledgment; now the cycle completes and merges.
    await harness.tools.sign_off({
      runId: run.id,
      verdict: "pass",
      grade: "Grade weak",
      acknowledgeTestChanges: true
    });
    entries = await waitForTranscript(
      harness.store,
      (transcript) => transcript.some((entry) => entry.type === "cycle_complete")
    );
    expect(mergeCallCount(harness.gitCalls)).toBe(1);
    expect(entries.find((entry) => entry.type === "cycle_complete")?.data).toEqual({
      branch: branchFor(run.id),
      grade: "Grade weak",
      acknowledgedTestChanges: true
    });
  });

  it("accumulates the architect's per-turn usage into the end-of-loop summary (model + tokens + time)", async () => {
    // The architect reports model + tokens + cost + duration on each `usage` (turn-end) event. The
    // orchestrator must accumulate them across turns and surface a single summary at cycle completion
    // so the operator can see what the architect side spent. The builder side produces no usage.
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build with telemetry");
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "user_message"));

    const run = latestRun(harness.runService);
    const session = currentSession(harness);
    session.input.onEvent?.({ type: "status", label: "initializing", model: "claude-opus-4-5" });
    session.input.onEvent?.({ type: "text_delta", delta: "Planning it." });
    // Two turns, each reporting usage; the summary must sum both.
    session.input.onEvent?.({
      type: "usage",
      usage: { input_tokens: 1200, output_tokens: 340 },
      costUsd: 0.0123,
      durationMs: 4200
    });
    session.input.onEvent?.({ type: "text_delta", delta: "Handing off." });
    session.input.onEvent?.({
      type: "usage",
      usage: { input_tokens: 800, output_tokens: 260 },
      costUsd: 0.008,
      durationMs: 3100
    });

    const approval = harness.tools.propose_plan({ runId: run.id, title: "Telemetry plan", plan: "Build it." });
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "plan_proposed"));
    harness.orchestrator.approve(conversationId, "approved");
    await approval;
    await harness.tools.handoff_to_codex({
      runId: run.id,
      project: "fake",
      objective: "Build it",
      context: "ctx",
      constraints: "none",
      verification: ["npm test"],
      stop_conditions: ["stop"]
    });
    await harness.tools.sign_off({ runId: run.id, verdict: "pass", grade: "Grade telemetry" });

    const entries = await waitForTranscript(harness.store, (t) => t.filter((e) => e.type === "usage").length >= 2);
    const architectUsage = entries.find((entry) => entry.type === "usage" && entry.data.side === "architect");
    expect(architectUsage?.data).toMatchObject({
      side: "architect",
      model: "claude-opus-4-5",
      inputTokens: 2000,
      outputTokens: 600,
      durationMs: 7300,
      costUsd: 0.0203,
      effort: "max"
    });
    // The builder side is also represented: the build wall-clock is surfaced (captured around the
    // build). This harness uses a custom run builder that does not emit build_usage, so durationMs is
    // 0 and no effort is configured — only the side label + the (zeroed) build time are asserted here.
    // The real run-builder path (exercised by the "bridges a full live cycle" test) emits a measured
    // build wall-clock + the configured builder effort.
    const builderUsage = entries.find((entry) => entry.type === "usage" && entry.data.side === "builder");
    expect(builderUsage?.data).toMatchObject({ side: "builder", durationMs: 0 });
    // The usage summaries land after the cycle_complete marker.
    const order = entries.map((entry) => entry.type);
    expect(order.indexOf("cycle_complete")).toBeLessThan(order.indexOf("usage"));
  });

  it("keeps one run and session alive across multiple cycles with the same builder branch and worktree", async () => {
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);

    await harness.orchestrator.sendMessage(conversationId, "first cycle");
    await drivePassingCycle(harness, "first");
    await waitForTranscript(harness.store, (entries) => entries.filter((entry) => entry.type === "cycle_complete").length === 1);

    await harness.orchestrator.sendMessage(conversationId, "second cycle");
    await drivePassingCycle(harness, "second");
    const entries = await waitForTranscript(
      harness.store,
      (transcript) => transcript.filter((entry) => entry.type === "cycle_complete").length === 2
    );

    expect(harness.sessionCalls).toHaveLength(1);
    expect(harness.sessionCalls[0]?.sends).toEqual(["first cycle", "second cycle"]);
    expect(mergeCallCount(harness.gitCalls)).toBe(2);
    expect(entries.filter((entry) => entry.type === "cycle_complete").map((entry) => entry.data)).toEqual([
      { branch: branchFor(runIdFor(1)), grade: "Grade first" },
      { branch: branchFor(runIdFor(1)), grade: "Grade second" }
    ]);
  });

  it("rebuilds a byte-identical handoff in a later cycle instead of returning a stale merged result", async () => {
    // Two cycles with IDENTICAL handoff content (same objective/context/constraints/...) in one
    // conversation. The build cache is keyed on (stable runId + content), so without per-cycle
    // clearing the second cycle would hit the cache, skip the rebuild, yet still sign off on the
    // phantom. With clearBuildCache on cycle_complete, the second cycle runs a REAL build: two
    // builder outputs, two merges, two completions.
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build it the same way twice");
    await drivePassingCycle(harness, "twin");
    await waitForTranscript(harness.store, (entries) => entries.filter((entry) => entry.type === "cycle_complete").length === 1);
    await drivePassingCycle(harness, "twin");
    const entries = await waitForTranscript(
      harness.store,
      (transcript) => transcript.filter((entry) => entry.type === "cycle_complete").length === 2
    );

    expect(entries.filter((entry) => entry.type === "build_output")).toHaveLength(2);
    expect(mergeCallCount(harness.gitCalls)).toBe(2);
  });

  it("ignores a duplicated sign_off until a new passing verifier result marks another cycle ready", async () => {
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build once");
    await drivePassingCycle(harness, "dedupe");
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "cycle_complete"));

    harness.runService.emit(latestRun(harness.runService), "sign_off", { runId: runIdFor(1), verdict: "pass" });
    await harness.orchestrator.stop(conversationId);

    expect(mergeCallCount(harness.gitCalls)).toBe(1);
  });

  it("parks a build whose --ff-only merge is refused, preserves the grade, and leaves the session usable", async () => {
    const gitCalls: string[][] = [];
    let mergeShouldFail = true;
    const throwingGit: GitRunner = async (args) => {
      gitCalls.push([...args]);
      if (args.includes("merge") && mergeShouldFail) {
        throw new Error("merge refused");
      }
      return { stdout: "", stderr: "" };
    };
    const harness = await createHarness({ git: throwingGit });
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build failing merge");
    await drivePassingCycle(harness, "merge-failure");
    const blockedEntries = await waitForTranscript(harness.store, (transcript) =>
      transcript.some((entry) => entry.type === "merge_blocked")
    );

    // KEEP-AND-PARK: not discarded as a generic error; the grade and the moved-target reason are
    // preserved on an explicit merge_blocked signal so the cycle stays re-signable.
    const blocked = blockedEntries.find((entry) => entry.type === "merge_blocked");
    expect(blocked?.data).toMatchObject({ branch: branchFor(runIdFor(1)), grade: "Grade merge-failure" });
    expect(blocked?.data.reason).toBe("merge refused");
    expect(blockedEntries.some((entry) => entry.type === "error")).toBe(false);
    expect(mergeCallCount(gitCalls)).toBe(1);
    expect(harness.sessionCalls[0]?.ended).toBe(false);

    // A re-issued sign_off retries the merge once the branch settles; this time it succeeds and
    // completes the cycle without losing the architect's grade.
    mergeShouldFail = false;
    harness.runService.emit(latestRun(harness.runService), "sign_off", { runId: runIdFor(1), verdict: "pass" });
    const completed = await waitForTranscript(harness.store, (transcript) =>
      transcript.some((entry) => entry.type === "cycle_complete")
    );
    expect(completed.find((entry) => entry.type === "cycle_complete")?.data).toEqual({
      branch: branchFor(runIdFor(1)),
      grade: "Grade merge-failure"
    });
    expect(mergeCallCount(gitCalls)).toBe(2);

    await harness.orchestrator.sendMessage(conversationId, "still alive");
    expect(harness.sessionCalls[0]?.sends).toEqual(["build failing merge", "still alive"]);
  });

  it("disables target-repo hooks on the --ff-only merge invocation", async () => {
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build with hook-safe merge");
    await drivePassingCycle(harness, "hooks");
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "cycle_complete"));

    const mergeCall = harness.gitCalls.find((args) => args.includes("merge"));
    expect(mergeCall).toBeDefined();
    expect(mergeCall).toEqual(["-C", harness.loopConfig.targetRepo, "-c", "core.hooksPath=/dev/null", "merge", "--ff-only", branchFor(runIdFor(1))]);
  });

  it("merges into the conversation's own target repo, overriding the loop-config default", async () => {
    // A conversation seeded with its own allowlisted targetRepo must build + merge into THAT repo,
    // not the server-configured loopConfig.targetRepo. This is the keystone of per-conversation target
    // selection: the operator picks a repo at New and the whole cycle stays scoped to it.
    const perConversationTarget = "/estate/projects/products/other-project";
    const harness = await createHarness({ conversationTargetRepo: perConversationTarget });
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build in the chosen repo");
    await drivePassingCycle(harness, "scoped");
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "cycle_complete"));

    const mergeCall = harness.gitCalls.find((args) => args.includes("merge"));
    expect(mergeCall).toBeDefined();
    // The merge runs -C against the per-conversation target, NOT loopConfig.targetRepo.
    expect(mergeCall?.[1]).toBe(perConversationTarget);
    expect(mergeCall?.[1]).not.toBe(harness.loopConfig.targetRepo);
    // The architect process is also scoped to that target (its cwd), so its ambient CLAUDE.md/hooks
    // come from the chosen repo rather than PlanForge's own tree or the loop-config default.
    expect(harness.sessionCalls[0]?.input.cwd).toBe(perConversationTarget);
  });

  it("completes the cycle when worktree removal fails AFTER a successful merge, not merge_blocked", async () => {
    // The --ff-only merge lands; only the follow-up worktree removal fails. That is a cleanup
    // warning, never merge_blocked (which would wrongly re-arm and re-merge an applied branch).
    const gitCalls: string[][] = [];
    const removalFailingGit: GitRunner = async (args) => {
      gitCalls.push([...args]);
      if (args.includes("worktree") && args.includes("remove")) {
        throw new Error("worktree busy");
      }
      return { stdout: "", stderr: "" };
    };
    const harness = await createHarness({ git: removalFailingGit });
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build then fail cleanup");
    await drivePassingCycle(harness, "cleanup-failure");

    const entries = await waitForTranscript(harness.store, (transcript) =>
      transcript.some((entry) => entry.type === "cycle_complete")
    );
    const complete = entries.find((entry) => entry.type === "cycle_complete");
    expect(complete?.data).toEqual({ branch: branchFor(runIdFor(1)), grade: "Grade cleanup-failure" });
    expect(entries.some((entry) => entry.type === "merge_blocked")).toBe(false);
    // A cleanup warning is surfaced (as an error entry) without blocking the cycle.
    const warning = entries.find((entry) => entry.type === "error");
    expect(stringField(warning?.data ?? {}, "message")).toContain("removing the build worktree");
    expect(mergeCallCount(gitCalls)).toBe(1);
  });

  it("settles the run terminal and evicts registry maps when a conversation is torn down", async () => {
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build then stop");
    await drivePassingCycle(harness, "evict");
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "cycle_complete"));
    const run = latestRun(harness.runService);

    // Before teardown the registry holds this run's handoff + verifier state.
    expect(harness.registry.handoffResultFor(run.id)).not.toBeNull();
    expect(harness.registry.verifierResultsFor(run.id).length).toBeGreaterThan(0);

    await harness.orchestrator.stop(conversationId);

    // After teardown the run is terminal and the registry no longer references the runId.
    expect(harness.runService.isTerminal(harness.runService.get(run.id)?.status ?? "queued")).toBe(true);
    expect(harness.registry.handoffResultFor(run.id)).toBeNull();
    expect(harness.registry.verifierResultsFor(run.id)).toEqual([]);
  });

  it("closes the run's registered MCP transports on stop teardown and drains the store", async () => {
    const mcpSessions: McpSessionStore = new Map();
    const harness = await createHarness({ mcpSessions });
    await harness.orchestrator.startRun(conversationId);
    const run = latestRun(harness.runService);

    let closed = 0;
    mcpSessions.set(
      run.id,
      new Set([
        {
          close: async () => {
            closed += 1;
          }
        }
      ])
    );

    await harness.orchestrator.stop(conversationId);

    expect(closed).toBe(1);
    expect(mcpSessions.has(run.id)).toBe(false);
  });

  it("deletes the run's MCP config when the architect session ends on its own", async () => {
    const harness = await createHarness({
      writeMcpConfig: async ({ runtimeRoot, runId }) => {
        const configPath = path.join(runtimeRoot, runId, ".mcp.json");
        await mkdir(path.dirname(configPath), { recursive: true });
        await writeFile(configPath, "{}\n", "utf8");
        return configPath;
      }
    });
    await harness.orchestrator.startRun(conversationId);
    const configPath = path.join(harness.loopConfig.runtimeRoot, runIdFor(1), ".mcp.json");
    expect(existsSync(configPath)).toBe(true);

    // The session ends by itself (no stop, no reap): the done handler's dropStateAfterDone path
    // must still remove the run's on-disk MCP config residue.
    currentSession(harness).resolveDone({ exitCode: 0, signal: null });

    await waitForGone(configPath);
  });

  it("sweeps runs/ residue older than the TTL opportunistically at conversation start", async () => {
    const harness = await createHarness();
    const runsRoot = path.join(harness.loopConfig.runtimeRoot, "runs");
    const staleDir = path.join(runsRoot, "stale-run");
    const freshDir = path.join(runsRoot, "fresh-run");
    await mkdir(staleDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });
    await writeFile(path.join(staleDir, "events.jsonl"), "", "utf8");
    await writeFile(path.join(freshDir, "events.jsonl"), "", "utf8");
    const stale = new Date(Date.now() - RUN_RESIDUE_TTL_MS - 24 * 60 * 60 * 1_000);
    await utimes(path.join(staleDir, "events.jsonl"), stale, stale);
    await utimes(staleDir, stale, stale);

    await harness.orchestrator.startRun(conversationId);

    await waitForGone(staleDir);
    // A run still inside the TTL window keeps its events.jsonl ops log untouched.
    expect(existsSync(path.join(freshDir, "events.jsonl"))).toBe(true);
  });

  it("emits an orphan signal naming the branch when idle-reaping a verified-but-unmerged build", async () => {
    // A build PASSED (registry holds a pass handoffResult with a branch + worktree) but the architect
    // went silent before sign_off, so it never merged. Idle-reaping it must NOT silently discard the
    // verified branch; it surfaces a distinct operator signal naming the orphaned branch + worktree.
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build but never sign off");
    const run = latestRun(harness.runService);
    const session = currentSession(harness);

    session.input.onEvent?.({ type: "text_delta", delta: "Architect plans." });
    const approval = harness.tools.propose_plan({ runId: run.id, title: "Plan", plan: "Build it." });
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "plan_proposed"));
    harness.orchestrator.approve(conversationId, "approved");
    await approval;
    // Drive the build to a passing handoff result, but DO NOT sign_off — it stays unmerged.
    await harness.tools.handoff_to_codex({
      runId: run.id,
      project: "fake",
      objective: "Build orphan",
      context: "fake context",
      constraints: "fake constraints",
      verification: ["npm test"],
      stop_conditions: ["stop after sign_off"]
    });

    // The registry holds a passing-but-unmerged handoff result for this run.
    expect(harness.registry.handoffResultFor(run.id)?.status).toBe("pass");

    // Idle-reap: the build settled so the reaper is re-armed; firing it tears the session down.
    harness.timers.latest().fire();

    const entries = await waitForTranscript(harness.store, (transcript) =>
      transcript.some(
        (entry) => entry.type === "error" && stringField(entry.data, "message")?.includes("orphaned") === true
      )
    );
    const orphanSignal = entries.find(
      (entry) => entry.type === "error" && stringField(entry.data, "message")?.includes("orphaned") === true
    );
    const message = stringField(orphanSignal?.data ?? {}, "message") ?? "";
    expect(message).toContain(branchFor(runIdFor(1)));
    expect(message).toContain("worktrees");
    expect(session.ended).toBe(true);
    // No merge happened — this is a discard signal, not a completed cycle.
    expect(mergeCallCount(harness.gitCalls)).toBe(0);
    expect(entries.some((entry) => entry.type === "cycle_complete")).toBe(false);
  });

  it("does not emit an orphan signal when reaping a conversation with no passing handoff result", async () => {
    // A conversation with no build (no handoffResult at all) reaped on idle must NOT emit the orphan
    // signal; the orphan path fires only for a still-pass-but-unmerged verified build.
    const harness = await createHarness();
    await harness.orchestrator.sendMessage(conversationId, "just chatting, no build");
    const run = latestRun(harness.runService);
    const session = harness.sessionCalls[0];
    if (!session) {
      throw new Error("Expected a fake session.");
    }

    expect(harness.registry.handoffResultFor(run.id)).toBeNull();

    harness.timers.latest().fire();
    expect(session.ended).toBe(true);

    // Let any queued transcript work flush, then confirm no orphan error entry was appended.
    await flushMicrotasks();
    const entries = await harness.store.readTranscript(conversationId);
    expect(
      entries.some(
        (entry) => entry.type === "error" && stringField(entry.data, "message")?.includes("orphaned") === true
      )
    ).toBe(false);
  });

  it("does not emit an orphan signal when reaping a conversation whose verified build already merged", async () => {
    // A completed cycle's pass handoffResult stays in the registry until evict; teardown must tell
    // it apart from a genuinely orphaned verified-but-unmerged build instead of crying wolf.
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build and sign off");
    await drivePassingCycle(harness, "merged-reap");
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "cycle_complete"));
    expect(mergeCallCount(harness.gitCalls)).toBe(1);
    expect(harness.registry.handoffResultFor(latestRun(harness.runService).id)?.merged).toBe(true);

    const session = currentSession(harness);
    harness.timers.latest().fire();
    expect(session.ended).toBe(true);

    await flushMicrotasks();
    const entries = await harness.store.readTranscript(conversationId);
    expect(
      entries.some(
        (entry) => entry.type === "error" && stringField(entry.data, "message")?.includes("orphaned") === true
      )
    ).toBe(false);
  });

  it("recovers a verified-but-unsigned build on turn-end by re-prompting the architect exactly once", async () => {
    // Transport-drop recovery: the build passed but the architect's handoff_to_codex result was lost,
    // so its turn ends (usage) with no sign_off. The orchestrator re-prompts the still-alive session
    // ONCE with the durable result; the architect then grades + signs off and the cycle merges.
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build then drop");
    const run = latestRun(harness.runService);
    const session = currentSession(harness);

    session.input.onEvent?.({ type: "text_delta", delta: "Architect plans." });
    // Planning turn ends BEFORE any build — no build result, so this must NOT trigger a recovery.
    session.input.onEvent?.({ type: "usage" });
    const approval = harness.tools.propose_plan({ runId: run.id, title: "Plan", plan: "Build it." });
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "plan_proposed"));
    harness.orchestrator.approve(conversationId, "approved");
    await approval;
    await harness.tools.handoff_to_codex({
      runId: run.id,
      project: "fake",
      objective: "Build dropped",
      context: "fake context",
      constraints: "fake constraints",
      verification: ["npm test"],
      stop_conditions: ["stop after sign_off"]
    });

    // The architect's turn ends WITHOUT a sign_off (the dropped handoff errored its tool call). Two
    // turn-ends arrive; the recovery must fire only once (one nudge budget per build cycle).
    session.input.onEvent?.({ type: "usage" });
    session.input.onEvent?.({ type: "usage" });

    const entries = await waitForTranscript(harness.store, (transcript) =>
      transcript.some((entry) => entry.type === "recovery")
    );
    await flushMicrotasks();
    const afterFlush = await harness.store.readTranscript(conversationId);
    expect(afterFlush.filter((entry) => entry.type === "recovery")).toHaveLength(1);
    const recovery = entries.find((entry) => entry.type === "recovery");
    expect(stringField(recovery?.data ?? {}, "branch")).toBe(branchFor(runIdFor(1)));
    const recoverySends = session.sends.filter((text) => text.includes("Recovery notice"));
    expect(recoverySends).toHaveLength(1);
    expect(recoverySends[0]).toContain(run.id);
    expect(recoverySends[0]).toContain("sign_off");

    // The architect now grades + signs off; the cycle completes and merges exactly once.
    await harness.tools.sign_off({ runId: run.id, verdict: "pass", grade: "Grade recovered" });
    const completed = await waitForTranscript(harness.store, (transcript) =>
      transcript.some((entry) => entry.type === "cycle_complete")
    );
    expect(completed.find((entry) => entry.type === "cycle_complete")?.data).toEqual({
      branch: branchFor(runIdFor(1)),
      grade: "Grade recovered"
    });
    expect(mergeCallCount(harness.gitCalls)).toBe(1);
  });

  it("does not re-prompt on a turn-end after a normal sign_off (cycleReady already consumed)", async () => {
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build normally");
    await drivePassingCycle(harness, "normal");
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "cycle_complete"));
    const session = currentSession(harness);

    // A turn-end after a completed+merged cycle must NOT trigger a recovery — cycleReady was consumed.
    session.input.onEvent?.({ type: "usage" });
    await flushMicrotasks();
    const entries = await harness.store.readTranscript(conversationId);
    expect(entries.some((entry) => entry.type === "recovery")).toBe(false);
    expect(session.sends.some((text) => text.includes("Recovery notice"))).toBe(false);
  });

  it("does not re-prompt a merge-parked build on turn-end (the architect already graded it)", async () => {
    const throwingGit: GitRunner = async (args) => {
      if (args.includes("merge")) {
        throw new Error("merge refused");
      }
      return { stdout: "", stderr: "" };
    };
    const harness = await createHarness({ git: throwingGit });
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build parked");
    await drivePassingCycle(harness, "parked");
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "merge_blocked"));
    const session = currentSession(harness);

    // After a park, cycleReady is re-armed and pendingGrade preserved; a turn-end must NOT nudge —
    // the architect already graded, so this is the re-sign recovery path, not a transport drop.
    session.input.onEvent?.({ type: "usage" });
    await flushMicrotasks();
    const entries = await harness.store.readTranscript(conversationId);
    expect(entries.some((entry) => entry.type === "recovery")).toBe(false);
    expect(session.sends.some((text) => text.includes("Recovery notice"))).toBe(false);
  });

  it("does not reap an architect that is silent while a Codex build is in flight, and still merges on sign_off", async () => {
    // The build emits codex_stream, then pauses (architect silent) past the idle timeout, then
    // emits a passing verifier_result. The conversation must NOT be torn down during that window.
    let releaseBuild: () => void = () => {};
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const harness = await createHarness({
      makeRunBuilder: ({ runService, loopConfig }) => async (handoff): Promise<HandoffResult> => {
        const run = runService.get(handoff.runId);
        if (!run) {
          throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${handoff.runId} was not found.`);
        }
        runService.emit(run, "codex_stream", { runId: handoff.runId, chunk: `builder output for ${handoff.objective}` });
        await buildGate;
        runService.emit(run, "verifier_result", {
          runId: handoff.runId,
          status: "pass",
          verifierResults,
          summary: "Verifier status: pass."
        });
        return {
          status: "pass",
          verifierResults,
          branch: branchFor(handoff.runId),
          worktreePath: path.join(loopConfig.runtimeRoot, "worktrees", handoff.runId)
        };
      }
    });
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build with a slow codex");
    const run = latestRun(harness.runService);
    const session = currentSession(harness);

    session.input.onEvent?.({ type: "text_delta", delta: "Architect plans." });
    session.input.onEvent?.({ type: "usage" });
    const approval = harness.tools.propose_plan({ runId: run.id, title: "Plan", plan: "Build it." });
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "plan_proposed"));
    harness.orchestrator.approve(conversationId, "approved");
    await approval;
    const handoffPromise = harness.tools.handoff_to_codex({
      runId: run.id,
      project: "fake",
      objective: "Build slow",
      context: "fake context",
      constraints: "fake constraints",
      verification: ["npm test"],
      stop_conditions: ["stop after sign_off"]
    });

    // The first builder output marks the build in flight; wait for it to land in the transcript.
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "build_output"));

    // Simulate 10 min of architect silence DURING the build: every idle timer armed so far must be
    // inactive (paused), so firing them is a no-op and the session is not torn down.
    for (const handle of harness.timers.handles) {
      handle.fire();
    }
    expect(session.ended).toBe(false);
    // A torn-down conversation cancels its run; a still-live one keeps it running.
    expect(harness.runService.get(run.id)?.status).toBe("running");

    // Release the build; the passing verifier + sign_off-driven merge still completes the cycle.
    releaseBuild();
    await handoffPromise;
    await harness.tools.sign_off({ runId: run.id, verdict: "pass", grade: "Grade slow" });
    const entries = await waitForTranscript(
      harness.store,
      (transcript) => transcript.filter((entry) => entry.type === "cycle_complete").length === 1
    );
    expect(entries.find((entry) => entry.type === "cycle_complete")?.data).toEqual({
      branch: branchFor(runIdFor(1)),
      grade: "Grade slow"
    });
    expect(mergeCallCount(harness.gitCalls)).toBe(1);
    expect(session.ended).toBe(false);
  });

  it("aborts an in-flight build on stop, settles it blocked, and tears the conversation down", async () => {
    // /stop during a build must cancel the build immediately (abort its signal) instead of leaving it
    // to run to the build wall — the abort makes handoff_to_codex resolve so the architect unblocks.
    let capturedSignal: AbortSignal | undefined;
    const harness = await createHarness({
      makeRunBuilder: ({ runService, loopConfig }) => async (handoff, options): Promise<HandoffResult> => {
        capturedSignal = options?.signal;
        const run = runService.get(handoff.runId);
        if (!run) {
          throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${handoff.runId} was not found.`);
        }
        runService.emit(run, "codex_stream", { runId: handoff.runId, chunk: `builder output for ${handoff.objective}` });
        // Mirror runCodexBuilder: stay in flight until aborted, then settle blocked (killGroup result).
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            resolve();
            return;
          }
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        runService.emit(run, "verifier_result", {
          runId: handoff.runId,
          status: "blocked",
          verifierResults: [{ name: "codex", status: "blocked", output: "build canceled" }],
          summary: "Verifier status: blocked (build canceled)."
        });
        return {
          status: "blocked",
          verifierResults: [{ name: "codex", status: "blocked", output: "build canceled" }],
          branch: branchFor(handoff.runId),
          worktreePath: path.join(loopConfig.runtimeRoot, "worktrees", handoff.runId)
        };
      }
    });
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build then stop");
    const run = latestRun(harness.runService);
    const session = currentSession(harness);

    session.input.onEvent?.({ type: "text_delta", delta: "Architect plans." });
    const approval = harness.tools.propose_plan({ runId: run.id, title: "Plan", plan: "Build it." });
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "plan_proposed"));
    harness.orchestrator.approve(conversationId, "approved");
    await approval;
    // Kick off the build but do NOT await it — it blocks until aborted (as a real handoff would).
    const handoffPromise = harness.tools.handoff_to_codex({
      runId: run.id,
      project: "fake",
      objective: "Build canceled",
      context: "fake context",
      constraints: "fake constraints",
      verification: ["npm test"],
      stop_conditions: ["stop after sign_off"]
    });
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "build_output"));
    expect(capturedSignal?.aborted).toBe(false);

    // Stop must complete (not hang on the in-flight build) and abort the build.
    await harness.orchestrator.stop(conversationId);
    expect(capturedSignal?.aborted).toBe(true);
    await expect(handoffPromise).resolves.toMatchObject({ status: "blocked" });
    expect(harness.runService.isTerminal(harness.runService.get(run.id)?.status ?? "queued")).toBe(true);
  });

  it("re-arms the idle reaper when a build emits codex_stream then errors, so a later fire tears the session down", async () => {
    // A build that streams (pausing the reaper) then throws must settle via a terminal error event;
    // otherwise buildInFlight stays true and the reaper is paused forever. The error re-arms the
    // idle timer, and firing it must tear the now-genuinely-idle session down.
    const buildError = new PlanForgeError("E_BUILD_THREW", "post-build git ops blew up");
    const harness = await createHarness({
      makeRunBuilder: ({ runService }) => async (handoff): Promise<HandoffResult> => {
        const run = runService.get(handoff.runId);
        if (!run) {
          throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${handoff.runId} was not found.`);
        }
        // Mirror run-builder's catch: stream (build in flight), then emit a terminal error and
        // re-throw the original cause so the handoff call still rejects with it.
        runService.emit(run, "codex_stream", { runId: handoff.runId, chunk: `builder output for ${handoff.objective}` });
        runService.emit(run, "error", { runId: handoff.runId, message: buildError.message });
        throw buildError;
      }
    });
    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "build that dies mid-flight");
    const run = latestRun(harness.runService);
    const session = currentSession(harness);

    session.input.onEvent?.({ type: "text_delta", delta: "Architect plans." });
    const approval = harness.tools.propose_plan({ runId: run.id, title: "Plan", plan: "Build it." });
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "plan_proposed"));
    harness.orchestrator.approve(conversationId, "approved");
    await approval;

    await expect(
      harness.tools.handoff_to_codex({
        runId: run.id,
        project: "fake",
        objective: "Build dies",
        context: "fake context",
        constraints: "fake constraints",
        verification: ["npm test"],
        stop_conditions: ["stop after sign_off"]
      })
    ).rejects.toBe(buildError);

    // The terminal error landed in the transcript (build settled), not a verifier pass.
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "error"));
    expect(session.ended).toBe(false);

    // markBuildSettled re-armed the idle reaper; the freshly-armed timer is active again, and firing
    // it now tears the session down (the build no longer pins the conversation open).
    const reArmed = harness.timers.latest();
    expect(reArmed.active).toBe(true);
    reArmed.fire();
    expect(session.ended).toBe(true);
  });

  it("still reaps a genuinely idle architect with no build in flight once the timeout fires", async () => {
    const harness = await createHarness();
    await harness.orchestrator.sendMessage(conversationId, "just chatting, no build");
    const session = harness.sessionCalls[0];
    if (!session) {
      throw new Error("Expected a fake session.");
    }

    // No codex_stream ever arrived, so the reaper is armed; firing it tears the session down.
    harness.timers.latest().fire();

    expect(session.ended).toBe(true);
  });

  it("rejects a pending propose_plan with E_APPROVAL_CANCELED when the conversation is stopped", async () => {
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    const run = latestRun(harness.runService);

    const approval = harness.tools.propose_plan({
      runId: run.id,
      title: "Plan to cancel",
      plan: "Build something we will tear down before approving."
    });
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "plan_proposed"));

    await harness.orchestrator.stop(conversationId);

    await expect(approval).rejects.toMatchObject({ code: "E_APPROVAL_CANCELED" });
    expect(harness.registry.pendingApprovalsCount()).toBe(0);
  });

  it("rejects a pending propose_plan with E_APPROVAL_CANCELED when the conversation is idle-reaped", async () => {
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    const run = latestRun(harness.runService);

    const approval = harness.tools.propose_plan({
      runId: run.id,
      title: "Plan to reap",
      plan: "Build something the idle reaper tears down before approval."
    });
    await waitForTranscript(harness.store, (entries) => entries.some((entry) => entry.type === "plan_proposed"));

    harness.timers.latest().fire();

    await expect(approval).rejects.toMatchObject({ code: "E_APPROVAL_CANCELED" });
  });

  it("assembles text deltas into one architect message before a tool_use entry", async () => {
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    const session = currentSession(harness);
    const run = latestRun(harness.runService);

    const events: DaemonAgentPayload[] = [
      { type: "text_delta", delta: "Hello " },
      { type: "text_delta", delta: "there" },
      { type: "tool_use", id: "tool-1", name: "mcp__planforge__propose_plan", input: { runId: run.id } }
    ];
    for (const event of events) {
      session.input.onEvent?.(event);
    }
    const entries = await waitForTranscript(harness.store, (transcript) => transcript.length === 2);

    expect(entries.map((entry) => entry.type)).toEqual(["architect_message", "tool_use"]);
    expect(entries[0]?.data).toEqual({ text: "Hello there" });
    expect(entries[1]?.data).toEqual({ name: "mcp__planforge__propose_plan", input: { runId: run.id } });
  });

  it("does not spawn a second session for a live conversation", async () => {
    const harness = await createHarness();

    await harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.startRun(conversationId);

    expect(harness.sessionCalls).toHaveLength(1);
    expect(harness.runService.list()).toHaveLength(1);
  });

  it("auto-starts a fresh conversation on first send and marks sessionStarted", async () => {
    const harness = await createHarness();

    await harness.orchestrator.sendMessage(conversationId, "first message");

    expect(harness.sessionCalls).toHaveLength(1);
    expect(harness.sessionCalls[0]?.input).toMatchObject({ sessionId: conversationId, resume: false });
    expect(harness.sessionCalls[0]?.sends).toEqual(["first message"]);
    await expect(harness.store.get(conversationId)).resolves.toMatchObject({ sessionStarted: true });
  });

  it("waits for an in-flight start before sending a concurrent message", async () => {
    const harness = await createHarness();

    const starting = harness.orchestrator.startRun(conversationId);
    await harness.orchestrator.sendMessage(conversationId, "during start");
    await starting;

    expect(harness.sessionCalls).toHaveLength(1);
    expect(harness.sessionCalls[0]?.input).toMatchObject({ sessionId: conversationId, resume: false });
    expect(harness.sessionCalls[0]?.sends).toEqual(["during start"]);
  });

  it("reaps an idle conversation without deleting the conversation or transcript", async () => {
    const harness = await createHarness();
    await harness.orchestrator.sendMessage(conversationId, "persist me");
    const firstSession = harness.sessionCalls[0];
    if (!firstSession) {
      throw new Error("Expected first fake session.");
    }

    harness.timers.latest().fire();

    expect(firstSession.ended).toBe(true);
    await expect(harness.store.get(conversationId)).resolves.toMatchObject({ id: conversationId, sessionStarted: true });
    await expect(harness.store.readTranscript(conversationId)).resolves.toMatchObject([
      { seq: 1, type: "user_message", data: { text: "persist me" } }
    ]);
  });

  it("resumes after reap and appends new transcript entries after the old seq", async () => {
    const harness = await createHarness();
    await harness.orchestrator.sendMessage(conversationId, "before reap");
    harness.timers.latest().fire();

    await harness.orchestrator.sendMessage(conversationId, "after reap");
    const entries = await harness.store.readTranscript(conversationId);

    expect(harness.sessionCalls).toHaveLength(2);
    expect(harness.sessionCalls[1]?.input).toMatchObject({ sessionId: conversationId, resume: true });
    expect(harness.sessionCalls[1]?.sends).toEqual(["after reap"]);
    expect(entries.map((entry) => [entry.seq, entry.type, entry.data])).toEqual([
      [1, "user_message", { text: "before reap" }],
      [2, "user_message", { text: "after reap" }]
    ]);
  });

  it("resumes after a bare start was reaped before any transcript entry existed", async () => {
    const harness = await createHarness();

    await harness.orchestrator.startRun(conversationId);
    expect(harness.sessionCalls[0]?.input).toMatchObject({ sessionId: conversationId, resume: false });
    await expect(harness.store.readTranscript(conversationId)).resolves.toEqual([]);
    harness.timers.latest().fire();

    await harness.orchestrator.sendMessage(conversationId, "after bare start");

    expect(harness.sessionCalls).toHaveLength(2);
    expect(harness.sessionCalls[1]?.input).toMatchObject({ sessionId: conversationId, resume: true });
    expect(harness.sessionCalls[1]?.sends).toEqual(["after bare start"]);
  });

  it("guards teardown so an old done cannot evict a newly resumed session", async () => {
    const harness = await createHarness({ deferDoneOnEnd: true });

    await harness.orchestrator.sendMessage(conversationId, "before reap");
    const oldSession = harness.sessionCalls[0];
    if (!oldSession) {
      throw new Error("Expected old fake session.");
    }
    harness.timers.latest().fire();
    await harness.orchestrator.sendMessage(conversationId, "after resume");
    const resumedSession = harness.sessionCalls[1];
    if (!resumedSession) {
      throw new Error("Expected resumed fake session.");
    }

    oldSession.resolveDone({ exitCode: 0, signal: null });
    await flushMicrotasks();
    await harness.orchestrator.sendMessage(conversationId, "still resumed");

    expect(harness.sessionCalls).toHaveLength(2);
    expect(resumedSession.input).toMatchObject({ sessionId: conversationId, resume: true });
    expect(resumedSession.sends).toEqual(["after resume", "still resumed"]);
  });

  it("resets the idle timer on activity before the timeout fires", async () => {
    const harness = await createHarness();
    await harness.orchestrator.startRun(conversationId);
    const firstTimer = harness.timers.latest();

    await harness.orchestrator.sendMessage(conversationId, "activity");
    const resetTimer = harness.timers.latest();
    firstTimer.fire();

    expect(firstTimer.active).toBe(false);
    expect(harness.sessionCalls[0]?.ended).toBe(false);
    resetTimer.fire();
    expect(harness.sessionCalls[0]?.ended).toBe(true);
  });

  it("throws E_CONVERSATION_NOT_FOUND when sendMessage targets a never-created conversation", async () => {
    const harness = await createHarness();

    await expect(harness.orchestrator.sendMessage(missingConversationId, "missing")).rejects.toMatchObject({
      code: "E_CONVERSATION_NOT_FOUND"
    });
  });

  it("keeps E_NO_LIVE_RUN for approve on a dormant conversation", async () => {
    const harness = await createHarness();

    expect(() => harness.orchestrator.approve(conversationId, "approved")).toThrow(
      expect.objectContaining({ code: "E_NO_LIVE_RUN" })
    );
  });

  it("keeps concurrent transcript appends gap-free and unique", async () => {
    const harness = await createHarness();

    await Promise.all(
      Array.from({ length: 25 }, (_, index) => harness.store.append(conversationId, "user_message", { text: `msg ${index}` }))
    );
    const entries = await harness.store.readTranscript(conversationId);

    expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(new Set(entries.map((entry) => entry.seq)).size).toBe(entries.length);
  });

  it("completes a full cycle after reap and resume", async () => {
    const harness = await createHarness();
    await harness.orchestrator.sendMessage(conversationId, "before cycle");
    harness.timers.latest().fire();
    await harness.orchestrator.sendMessage(conversationId, "build after resume");

    await drivePassingCycle(harness, "resumed");
    const entries = await waitForTranscript(
      harness.store,
      (transcript) => transcript.filter((entry) => entry.type === "cycle_complete").length === 1
    );

    expect(harness.sessionCalls).toHaveLength(2);
    expect(harness.sessionCalls[1]?.input).toMatchObject({ sessionId: conversationId, resume: true });
    expect(entries.map((entry) => entry.type)).toEqual([
      "user_message",
      "user_message",
      "architect_message",
      "plan_proposed",
      "approval",
      "build_output",
      "verify_result",
      "cycle_complete",
      "usage",
      "usage"
    ]);
    expect(entries.find((entry) => entry.type === "cycle_complete")?.data).toEqual({
      branch: branchFor(runIdFor(2)),
      grade: "Grade resumed"
    });
    expect(mergeCallCount(harness.gitCalls)).toBe(1);
  });

  it("builds the conversational architect prompt with the pinned tools and a single Run ID line", () => {
    const loopConfig: PlanForgeLoopConfig = {
      targetRepo: "/repo",
      runtimeRoot: "/runtime",
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "tests", command: "npm test" }]
    };
    const prompt = buildConversationalArchitectPrompt({
      runId: runIdFor(1),
      loopConfig,
      repoManifest: "Files (git-tracked):\nRun ID: from-manifest\nsrc/index.ts"
    });
    const emptyPrompt = buildConversationalArchitectPrompt({ runId: runIdFor(1), loopConfig, repoManifest: "" });

    expect(prompt).toContain("mcp__planforge__read_repo_file");
    expect(prompt).toContain("mcp__planforge__propose_plan");
    expect(prompt).toContain("mcp__planforge__handoff_to_codex");
    expect(prompt).toContain("mcp__planforge__sign_off");
    // The test-weakening review instruction must be present so the architect reviews the diff and only
    // acknowledges a justified weakening (never a blanket ack to clear the gate).
    expect(prompt).toContain("test_delta shows weakening");
    expect(prompt).toContain("acknowledgeTestChanges:true");
    expect(prompt).toContain("Never blanket-acknowledge");
    expect(prompt).toContain("After sign_off, briefly summarize what was built and wait for the operator's next message.");
    expect(prompt).toContain("Do not exit");
    expect(prompt).toContain("do not start another plan unprompted");
    expect(prompt).toContain("  Run ID: from-manifest");
    expect(prompt).toContain("  src/index.ts");
    expect(prompt.match(/^Run ID: /gm)).toHaveLength(1);
    expect(emptyPrompt.match(/^Run ID: /gm)).toHaveLength(1);
    expect(emptyPrompt).not.toContain("Repository context (read-only, for planning):");
  });

  it("overrides the configured target repo in the architect prompt for a per-conversation target", () => {
    const loopConfig: PlanForgeLoopConfig = {
      targetRepo: "/default-repo",
      runtimeRoot: "/runtime",
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "tests", command: "npm test" }]
    };
    // No override → the prompt uses the loopConfig default.
    const defaultPrompt = buildConversationalArchitectPrompt({ runId: runIdFor(1), loopConfig, repoManifest: "" });
    expect(defaultPrompt).toContain("Target repo: /default-repo");

    // A per-conversation target overrides it in the prompt.
    const overridden = buildConversationalArchitectPrompt({
      runId: runIdFor(1),
      loopConfig,
      repoManifest: "",
      targetRepo: "/allowed/per-conversation-repo"
    });
    expect(overridden).toContain("Target repo: /allowed/per-conversation-repo");
    expect(overridden).not.toContain("/default-repo");
  });
});
