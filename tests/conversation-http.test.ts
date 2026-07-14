import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { StartArchitectSessionInput } from "../src/architect/claude-session";
import type { ClaudeSpawnResult } from "../src/architect/claude-driver";
import type { GitRunner } from "../src/builder/codex-driver";
import type { TimerHandle } from "../src/conversation-orchestrator";
import { createConversationStore, type ConversationStore, type TranscriptEntry } from "../src/conversation-store";
import type { DaemonAgentPayload, VerifierResult } from "../src/domain";
import { PlanForgeError } from "../src/errors";
import { createPlanForgeToolHandlers } from "../src/tools";
import { listenPlanForgeServer, type ListeningPlanForgeServer, type PlanForgeLoopConfig } from "../src/start-server";
import type { CodexRunRequest } from "../src/builder/codex-driver";

const tempDirs: string[] = [];
const servers: ListeningPlanForgeServer[] = [];
const verifierResults: readonly VerifierResult[] = [{ name: "fake verifier", status: "pass", exitCode: 0, output: "ok" }];
const knownMissingConversationId = "22222222-2222-4222-8222-222222222222";

type SseFrame = {
  readonly id: number;
  readonly event: string;
  readonly data: TranscriptEntry;
};

type FakeSessionCall = {
  readonly input: StartArchitectSessionInput;
  readonly sends: string[];
  ended: boolean;
  resolveDone(result: ClaudeSpawnResult): void;
  rejectDone(error: Error): void;
};

type FakeTimerHandle = TimerHandle & {
  active: boolean;
  fire(): void;
};

type FakeTimers = {
  readonly handles: readonly FakeTimerHandle[];
  readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer: (handle: TimerHandle) => void;
};

type TestServer = {
  readonly server: ListeningPlanForgeServer;
  readonly baseUrl: string;
  readonly runtimeRoot: string;
  readonly sessionCalls: FakeSessionCall[];
  readonly codexRequests: Array<Pick<CodexRunRequest, "argv" | "stdin">>;
  readonly gitCalls: readonly string[][];
  readonly timers: FakeTimers;
};

async function removeTempDir(dir: string): Promise<void> {
  // A best-effort recursive remove that retries on ENOTEMPTY/EBUSY: an SSE response body draining on
  // the just-closed server can briefly hold a transcript file, racing the cleanup. force:true already
  // ignores ENOENT; this adds a short retry for the in-flight-handle race so the suite is reliably green.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw error;
    }
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (listeningServer) =>
        new Promise<void>((resolve, reject) => {
          listeningServer.server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
          listeningServer.server.closeAllConnections();
        })
    )
  );
  await Promise.all(tempDirs.map(removeTempDir));
  tempDirs.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-conversation-http-"));
  tempDirs.push(root);
  return root;
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function fetchWithLabel(input: string, init: RequestInit | undefined, label: string): Promise<Response> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fetch(input, init),
      new Promise<Response>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for fetch: ${label}`)), 1_000);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for assertion.");
}

function createFakeTimers(): FakeTimers {
  const handles: FakeTimerHandle[] = [];
  return {
    handles,
    setTimer(fn) {
      const handle: FakeTimerHandle = {
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
    }
  };
}

function makeFakeStartSession(calls: FakeSessionCall[]) {
  return (input: StartArchitectSessionInput) => {
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
      send(text: string) {
        call.sends.push(text);
      },
      end() {
        call.ended = true;
        resolveDone({ exitCode: 0, signal: null });
      },
      done
    };
  };
}

function frameFromText(text: string): SseFrame {
  const idLine = text.split("\n").find((line) => line.startsWith("id: "));
  const eventLine = text.split("\n").find((line) => line.startsWith("event: "));
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!idLine || !eventLine || !dataLine) {
    throw new Error(`Malformed SSE frame: ${text}`);
  }
  return {
    id: Number(idLine.slice("id: ".length)),
    event: eventLine.slice("event: ".length),
    data: JSON.parse(dataLine.slice("data: ".length)) as TranscriptEntry
  };
}

function createSseReader(response: Response) {
  if (!response.body) {
    throw new Error("SSE response body missing.");
  }
  return {
    reader: response.body.getReader(),
    decoder: new TextDecoder(),
    buffer: ""
  };
}

async function readNextFrame(sse: ReturnType<typeof createSseReader>): Promise<SseFrame> {
  while (!sse.buffer.includes("\n\n")) {
    const chunk = await sse.reader.read();
    if (chunk.done) {
      throw new Error("SSE stream ended before the expected frame.");
    }
    sse.buffer += sse.decoder.decode(chunk.value, { stream: true });
  }
  const separatorIndex = sse.buffer.indexOf("\n\n");
  const frameText = sse.buffer.slice(0, separatorIndex);
  sse.buffer = sse.buffer.slice(separatorIndex + 2);
  return frameFromText(frameText);
}

async function readNextFrameWithLabel(sse: ReturnType<typeof createSseReader>, label: string): Promise<SseFrame> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      readNextFrame(sse),
      new Promise<SseFrame>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for SSE frame: ${label}`)), 1_000);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function readFrames(response: Response, count: number): Promise<SseFrame[]> {
  const sse = createSseReader(response);
  const frames: SseFrame[] = [];
  try {
    while (frames.length < count) {
      frames.push(await readNextFrame(sse));
    }
    return frames;
  } finally {
    await sse.reader.cancel();
  }
}

async function startTestServer(
  input: {
    readonly idleTimeoutMs?: number;
    readonly loopConfig?: Partial<PlanForgeLoopConfig>;
  } = {}
): Promise<TestServer> {
  const root = await tempRoot();
  const runtimeRoot = path.join(root, "runtime");
  // An allowlist-valid target: a standalone git repo under projects/<bucket>/ so the run-builder's
  // run-start re-validation passes (workspaceRoot = root, mirroring production).
  const targetRepo = path.join(root, "projects", "products", "target");
  await mkdir(path.join(targetRepo, ".git"), { recursive: true });
  const sessionCalls: FakeSessionCall[] = [];
  const gitCalls: string[][] = [];
  const git: GitRunner = async (args) => {
    gitCalls.push([...args]);
    // rev-parse HEAD resolves (a real repo always has a HEAD) so the test-delta base exists; the
    // empty diff means no test changes → a non-weakened delta that needs no acknowledgment.
    return args.includes("rev-parse") ? { stdout: "headsha\n", stderr: "" } : { stdout: "", stderr: "" };
  };
  const timers = createFakeTimers();
  const codexRequests: Array<Pick<CodexRunRequest, "argv" | "stdin">> = [];
  const server = await listenPlanForgeServer({
    port: 0,
    workspaceRoot: root,
    loopConfig: {
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "fake verifier", command: "npm test" }],
      ...input.loopConfig
    },
    startSession: makeFakeStartSession(sessionCalls),
    codexRunner: async (request) => {
      codexRequests.push({ argv: request.argv, stdin: request.stdin });
      request.onChunk("builder output\n");
      return { exitCode: 0 };
    },
    git,
    verifierRunner: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
    idleTimeoutMs: input.idleTimeoutMs ?? 10_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  servers.push(server);
  return { server, baseUrl: `http://${server.host}:${server.port}`, runtimeRoot, sessionCalls, codexRequests, gitCalls, timers };
}

async function createConversation(baseUrl: string, title = "Conversation loop"): Promise<string> {
  const response = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title })
  });
  expect(response.status).toBe(200);
  const body = await json<{ readonly id: string }>(response);
  return body.id;
}

async function postMessage(baseUrl: string, conversationId: string, text: string): Promise<Response> {
  return fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text })
  });
}

async function postApprove(
  baseUrl: string,
  conversationId: string,
  body: { readonly verdict: "approved" | "changes_requested"; readonly feedback?: string }
): Promise<Response> {
  return fetch(`${baseUrl}/api/conversations/${conversationId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function latestRunId(server: ListeningPlanForgeServer): string {
  const run = server.runService.list().at(-1);
  if (!run) {
    throw new Error("Expected a conversation run.");
  }
  return run.id;
}

async function drivePlanProposal(
  testServer: TestServer,
  title = "HTTP plan",
  sessionIndex = 0
): Promise<{ readonly approval: Promise<unknown> }> {
  await waitFor(() => testServer.sessionCalls.length === sessionIndex + 1);
  const runId = latestRunId(testServer.server);
  const session = testServer.sessionCalls[sessionIndex];
  session?.input.onEvent?.({ type: "text_delta", delta: "Architect says hello." });
  session?.input.onEvent?.({ type: "usage" });
  const tools = createPlanForgeToolHandlers({
    registry: testServer.server.registry,
    runService: testServer.server.runService,
    loopConfig: testServer.server.loopConfig
  });
  const approval = tools.propose_plan({
    runId,
    title,
    plan: "Build the HTTP conversation slice."
  });
  return { approval };
}

async function finishPassingCycle(testServer: TestServer): Promise<void> {
  const runId = latestRunId(testServer.server);
  const tools = createPlanForgeToolHandlers({
    registry: testServer.server.registry,
    runService: testServer.server.runService,
    loopConfig: testServer.server.loopConfig
  });
  await tools.handoff_to_codex({
    runId,
    project: "fake",
    objective: "Build HTTP API",
    context: "fake context",
    constraints: "fake constraints",
    verification: ["npm test"],
    stop_conditions: ["stop after sign_off"]
  });
  await tools.sign_off({ runId, verdict: "pass", grade: "Looks good." });
}

describe("PlanForge conversation HTTP API", () => {
  it("accepts, persists, lists, and PATCHes per-conversation model and effort controls", async () => {
    const testServer = await startTestServer({
      loopConfig: {
        architectModels: ["default", "opus", "sonnet", "haiku"],
        builderModels: ["default", "gpt-5.2-codex", "gpt-5.1-codex"]
      }
    });

    const created = await fetch(`${testServer.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Controls",
        architectModel: "opus",
        architectEffort: "max",
        builderModel: "gpt-5.2-codex",
        builderEffort: "xhigh"
      })
    });
    expect(created.status).toBe(200);
    const { id } = await json<{ readonly id: string }>(created);

    const listed = await json<{ readonly conversations: readonly unknown[] }>(
      await fetch(`${testServer.baseUrl}/api/conversations`)
    );
    expect(listed.conversations).toContainEqual(
      expect.objectContaining({
        id,
        architectModel: "opus",
        architectEffort: "max",
        builderModel: "gpt-5.2-codex",
        builderEffort: "xhigh"
      })
    );

    const patched = await fetch(`${testServer.baseUrl}/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        architectModel: "haiku",
        architectEffort: "low",
        builderModel: "gpt-5.1-codex",
        builderEffort: "minimal"
      })
    });
    expect(patched.status).toBe(200);
    await expect(json(patched)).resolves.toMatchObject({
      conversation: {
        architectModel: "haiku",
        architectEffort: "low",
        builderModel: "gpt-5.1-codex",
        builderEffort: "minimal"
      }
    });
  });

  it("rejects invalid model and effort controls with named 400 errors", async () => {
    const testServer = await startTestServer({
      loopConfig: {
        architectModels: ["default", "opus"],
        builderModels: ["default", "gpt-5.2-codex"]
      }
    });

    const invalidEffort = await fetch(`${testServer.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ architectEffort: "extreme" })
    });
    expect(invalidEffort.status).toBe(400);
    await expect(json(invalidEffort)).resolves.toMatchObject({ ok: false, code: "E_INVALID_EFFORT" });

    const invalidModel = await fetch(`${testServer.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ builderModel: "unlisted-codex" })
    });
    expect(invalidModel.status).toBe(400);
    await expect(json(invalidModel)).resolves.toMatchObject({ ok: false, code: "E_INVALID_MODEL" });
  });

  it("rejects PATCH model and effort edits after the conversation starts", async () => {
    const testServer = await startTestServer({
      loopConfig: {
        architectModels: ["default", "opus"],
        builderModels: ["default", "gpt-5.2-codex"]
      }
    });
    const conversationId = await createConversation(testServer.baseUrl);
    expect((await postMessage(testServer.baseUrl, conversationId, "Start it.")).status).toBe(200);

    const response = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ architectModel: "opus", builderEffort: "high" })
    });
    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toMatchObject({ ok: false, code: "E_SESSION_ALREADY_STARTED" });
  });

  it("threads configured controls into architect and builder runs with conversation-over-env fallback", async () => {
    const testServer = await startTestServer({
      loopConfig: {
        architectModels: ["default", "opus", "sonnet"],
        builderModels: ["default", "gpt-5.2-codex"],
        architectModel: "sonnet",
        architectEffort: "high",
        builderModel: "gpt-5.2-codex",
        builderEffort: "medium"
      }
    });

    const envDefaultId = await createConversation(testServer.baseUrl, "Env defaults");
    expect((await postMessage(testServer.baseUrl, envDefaultId, "Use env fallbacks.")).status).toBe(200);
    await waitFor(() => testServer.sessionCalls.length === 1);
    expect(testServer.sessionCalls[0]?.input).toMatchObject({ model: "sonnet", effort: "high" });
    const envApproval = await drivePlanProposal(testServer, "Env plan");
    await postApprove(testServer.baseUrl, envDefaultId, { verdict: "approved" });
    await envApproval.approval;
    await finishPassingCycle(testServer);
    expect(testServer.codexRequests[0]?.argv).toContain("-m");
    expect(testServer.codexRequests[0]?.argv).toContain("gpt-5.2-codex");
    expect(testServer.codexRequests[0]?.argv).toContain('model_reasoning_effort="medium"');

    const override = await fetch(`${testServer.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Conversation override",
        architectModel: "default",
        architectEffort: "max",
        builderModel: "default",
        builderEffort: "xhigh"
      })
    });
    const overrideId = (await json<{ readonly id: string }>(override)).id;
    expect((await postMessage(testServer.baseUrl, overrideId, "Override env.")).status).toBe(200);
    await waitFor(() => testServer.sessionCalls.length === 2);
    expect(testServer.sessionCalls[1]?.input).toMatchObject({ model: "default", effort: "max" });
    const overrideApproval = await drivePlanProposal(testServer, "Override plan", 1);
    await postApprove(testServer.baseUrl, overrideId, { verdict: "approved" });
    await overrideApproval.approval;
    await finishPassingCycle(testServer);
    expect(testServer.codexRequests[1]?.argv).not.toContain("-m");
    expect(testServer.codexRequests[1]?.argv).not.toContain("gpt-5.2-codex");
    expect(testServer.codexRequests[1]?.argv).toContain('model_reasoning_effort="xhigh"');
  });

  it("drives a full conversation lifecycle over HTTP and tails cycle_complete over transcript SSE", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl);
    expect(testServer.sessionCalls).toHaveLength(0);

    const list = await fetch(`${testServer.baseUrl}/api/conversations`);
    await expect(json<{ readonly conversations: readonly { readonly id: string }[] }>(list)).resolves.toMatchObject({
      conversations: [expect.objectContaining({ id: conversationId })]
    });

    const events = await fetchWithLabel(`${testServer.baseUrl}/api/conversations/${conversationId}/events`, undefined, "conversation events");
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const sse = createSseReader(events);
    const message = await postMessage(testServer.baseUrl, conversationId, "Please build the API.");
    expect(message.status).toBe(200);
    const { approval } = await drivePlanProposal(testServer);

    const first = await readNextFrameWithLabel(sse, "user_message");
    const second = await readNextFrameWithLabel(sse, "architect_message");
    const third = await readNextFrameWithLabel(sse, "plan_proposed");
    expect([first.event, second.event, third.event]).toEqual(["user_message", "architect_message", "plan_proposed"]);
    expect(first.data.data).toEqual({ text: "Please build the API." });
    expect(third.data.data).toMatchObject({ title: "HTTP plan" });

    const approve = await postApprove(testServer.baseUrl, conversationId, { verdict: "approved" });
    expect(approve.status).toBe(200);
    await approval;
    await finishPassingCycle(testServer);
    const postApprovalFrames = [
      await readNextFrameWithLabel(sse, "approval"),
      // The first build_output is the build-start context line (effective wall + worktree tail);
      // the second is the build-worktree node_modules link outcome (the fixture target has none
      // installed, so the fallback line). Both stream before any codex output.
      await readNextFrameWithLabel(sse, "build_output (build started)"),
      await readNextFrameWithLabel(sse, "build_output (deps link)"),
      await readNextFrameWithLabel(sse, "build_output"),
      // The deterministic test-weakening delta is surfaced (non-weakened here — no test changes)
      // before the verifier result the architect signs off against.
      await readNextFrameWithLabel(sse, "test_delta"),
      await readNextFrameWithLabel(sse, "verify_result"),
      // The builder's diff (stat + capped patch) streams after verify so the
      // sign-off gate is never blind (mobile-operator-ux F3).
      await readNextFrameWithLabel(sse, "change_diff"),
      await readNextFrameWithLabel(sse, "cycle_complete")
    ];
    expect(postApprovalFrames.map((frame) => frame.event)).toEqual([
      "approval",
      "build_output",
      "build_output",
      "build_output",
      "test_delta",
      "verify_result",
      "change_diff",
      "cycle_complete"
    ]);
    expect(JSON.stringify(postApprovalFrames[1]?.data)).toContain("build started (wall 30m");
    expect(JSON.stringify(postApprovalFrames[2]?.data)).toContain("did not link node_modules into the build worktree");
    expect(postApprovalFrames.at(-1)?.data.data).toMatchObject({ grade: "Looks good." });
    expect(postApprovalFrames.some((frame) => frame.event === "sign_off")).toBe(false);
    await sse.reader.cancel();
  });

  it("replays transcript SSE with Last-Event-ID and exposes transcript backfill with afterSeq", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl);
    await postMessage(testServer.baseUrl, conversationId, "First");
    await postMessage(testServer.baseUrl, conversationId, "Second");

    const fresh = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}/events`);
    const freshFrames = await readFrames(fresh, 2);
    expect(freshFrames.map((frame) => [frame.id, frame.event, frame.data.seq])).toEqual([
      [1, "user_message", 1],
      [2, "user_message", 2]
    ]);

    const replay = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}/events`, {
      headers: { "Last-Event-ID": "1" }
    });
    const replayFrames = await readFrames(replay, 1);
    expect(replayFrames.map((frame) => [frame.id, frame.event, frame.data.seq])).toEqual([[2, "user_message", 2]]);

    // A fresh EventSource cannot set Last-Event-ID, so the events route also resumes from ?afterSeq.
    const queryReplay = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}/events?afterSeq=1`);
    const queryFrames = await readFrames(queryReplay, 1);
    expect(queryFrames.map((frame) => [frame.id, frame.event, frame.data.seq])).toEqual([[2, "user_message", 2]]);

    // When both are present the header (the browser's auto-reconnect watermark) wins over the URL.
    const headerWins = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}/events?afterSeq=0`, {
      headers: { "Last-Event-ID": "1" }
    });
    const headerWinsFrames = await readFrames(headerWins, 1);
    expect(headerWinsFrames.map((frame) => [frame.id, frame.data.seq])).toEqual([[2, 2]]);

    const malformedEvents = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}/events?afterSeq=nope`);
    expect(malformedEvents.status).toBe(400);

    const transcript = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}/transcript?afterSeq=1`);
    await expect(json<{ readonly entries: readonly TranscriptEntry[] }>(transcript)).resolves.toMatchObject({
      entries: [expect.objectContaining({ seq: 2, type: "user_message" })]
    });

    const malformed = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}/transcript?afterSeq=nope`);
    expect(malformed.status).toBe(400);
  });

  it("returns JSON 404 before SSE headers for an unknown conversation event stream", async () => {
    const testServer = await startTestServer();
    const response = await fetch(`${testServer.baseUrl}/api/conversations/${knownMissingConversationId}/events`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    await expect(json(response)).resolves.toMatchObject({
      ok: false,
      code: "E_CONVERSATION_NOT_FOUND"
    });
  });

  it("self-heals a corrupt mid-file transcript line instead of dying, replaying the valid entries", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl);
    // Corrupt the transcript with an invalid entry that is NOT the last line, so it cannot be
    // dismissed as a repairable torn tail. Subscribe must quarantine just that line and keep
    // replaying the valid entries rather than throwing on every reconnect.
    const transcriptPath = path.join(
      testServer.runtimeRoot,
      "conversations",
      conversationId,
      "transcript.jsonl"
    );
    await writeFile(
      transcriptPath,
      [
        '{"seq":1,"ts":1,"type":"user_message","data":{"text":"hi"}}',
        '{"seq":2,"ts":2,"type":"bogus","data":{}}',
        '{"seq":3,"ts":3,"type":"user_message","data":{"text":"bye"}}',
        ""
      ].join("\n"),
      "utf8"
    );

    // Reconnect twice: a self-healing subscribe must succeed every time, not throw forever.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}/events`);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const frames = await readFrames(response, 2);
      expect(frames.map((frame) => [frame.event, frame.data.seq, frame.data.data])).toEqual([
        ["user_message", 1, { text: "hi" }],
        ["user_message", 3, { text: "bye" }]
      ]);
    }
  });

  it("emits a terminal stream_error frame and closes on an unrecoverable subscribe failure", async () => {
    // Inject a store whose subscribe throws after get() passes the endpoint's existence check, so
    // the handler hits its unrecoverable-failure path deterministically (a TOCTOU-style failure).
    const root = await tempRoot();
    const runtimeRoot = path.join(root, "runtime");
    const realStore = createConversationStore({ root: path.join(runtimeRoot, "conversations") });
    const conversation = await realStore.create({ title: "doomed stream" });
    const failingStore: ConversationStore = {
      ...realStore,
      subscribe: async () => {
        throw new PlanForgeError("E_CONVERSATION_SUBSCRIBE_FAILED", "transcript store is unreadable");
      }
    };
    const server = await listenPlanForgeServer({
      port: 0,
      loopConfig: {
        targetRepo: path.join(root, "target"),
        runtimeRoot,
        env: { PATH: "/usr/bin" },
        verifierCommands: [{ name: "fake verifier", command: "npm test" }]
      },
      conversationStore: failingStore,
      startSession: makeFakeStartSession([])
    });
    servers.push(server);
    const baseUrl = `http://${server.host}:${server.port}`;

    const response = await fetch(`${baseUrl}/api/conversations/${conversation.id}/events`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const sse = createSseReader(response);
    try {
      // The stream_error frame has no id line (it is not a transcript entry), so parse the raw text.
      while (!sse.buffer.includes("\n\n")) {
        const chunk = await Promise.race([
          sse.reader.read(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("Timed out waiting for the stream_error frame.")), 1_000)
          )
        ]);
        if (chunk.done) {
          throw new Error("SSE stream ended before the stream_error frame.");
        }
        sse.buffer += sse.decoder.decode(chunk.value, { stream: true });
      }
      const frameText = sse.buffer.slice(0, sse.buffer.indexOf("\n\n"));
      const eventLine = frameText.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = frameText.split("\n").find((line) => line.startsWith("data: "));
      expect(eventLine).toBe("event: stream_error");
      expect(JSON.parse((dataLine ?? "data: {}").slice("data: ".length))).toMatchObject({
        ok: false,
        code: "E_CONVERSATION_SUBSCRIBE_FAILED",
        message: "transcript store is unreadable"
      });
      // The client closed (cleanup ran): the stream ends with no further frames, so the browser
      // does not reconnect into a second events GET.
      const next = await Promise.race([
        sse.reader.read(),
        new Promise<{ readonly done: boolean }>((resolve) => setTimeout(() => resolve({ done: false }), 100))
      ]);
      expect(next.done).toBe(true);
    } finally {
      await sse.reader.cancel();
    }
  });

  it("maps conversation errors locally without collapsing every PlanForgeError to 400", async () => {
    const testServer = await startTestServer();
    const dormantId = await createConversation(testServer.baseUrl);
    const noPendingId = await createConversation(testServer.baseUrl);
    await postMessage(testServer.baseUrl, noPendingId, "Start without a pending plan.");

    const missing = await postMessage(testServer.baseUrl, knownMissingConversationId, "Missing");
    expect(missing.status).toBe(404);
    await expect(json(missing)).resolves.toMatchObject({ code: "E_CONVERSATION_NOT_FOUND" });

    const noLiveRun = await postApprove(testServer.baseUrl, dormantId, { verdict: "approved" });
    expect(noLiveRun.status).toBe(409);
    await expect(json(noLiveRun)).resolves.toMatchObject({ code: "E_NO_LIVE_RUN" });

    const noPending = await postApprove(testServer.baseUrl, noPendingId, { verdict: "approved" });
    expect(noPending.status).toBe(409);
    await expect(json(noPending)).resolves.toMatchObject({ code: "E_APPROVAL_NOT_FOUND" });
  });

  it("rejects non-UUID and traversal conversation ids before any store call", async () => {
    const testServer = await startTestServer();
    const secretPath = path.join(testServer.runtimeRoot, "secret");

    for (const badId of ["not-a-uuid", "..%2F..%2Fsecret"]) {
      const response = await postMessage(testServer.baseUrl, badId, "nope");
      expect(response.status).toBe(400);
    }

    await expect(rm(secretPath, { recursive: true, force: false })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes MCP config with the resolved ephemeral server port", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl);

    const response = await postMessage(testServer.baseUrl, conversationId, "Materialize run.");
    expect(response.status).toBe(200);
    const runId = latestRunId(testServer.server);
    const config = JSON.parse(await readFile(path.join(testServer.runtimeRoot, runId, ".mcp.json"), "utf8")) as {
      readonly mcpServers: { readonly planforge: { readonly url: string } };
    };

    expect(config.mcpServers.planforge.url).toBe(
      `http://${testServer.server.host}:${testServer.server.port}/mcp?runId=${encodeURIComponent(runId)}`
    );
    expect(config.mcpServers.planforge.url).not.toContain(":0/");
  });

  it("terminates an MCP session via spec DELETE and reaps the server-side transport", async () => {
    const testServer = await startTestServer();
    const transport = new StreamableHTTPClientTransport(new URL(`${testServer.baseUrl}/mcp`));
    const client = new Client({ name: "planforge-mcp-delete-test", version: "0.0.0" });
    await client.connect(transport);
    const sessionId = transport.sessionId ?? "";
    expect(sessionId).not.toBe("");

    // Methods outside the streamable-HTTP contract are still rejected.
    const put = await fetch(`${testServer.baseUrl}/mcp`, { method: "PUT", headers: { "mcp-session-id": sessionId } });
    expect(put.status).toBe(405);
    // A DELETE without a session id never reaches a transport.
    const missing = await fetch(`${testServer.baseUrl}/mcp`, { method: "DELETE" });
    expect(missing.status).toBe(400);

    // Spec session termination: DELETE with the session id routes through the SDK transport.
    const del = await fetch(`${testServer.baseUrl}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
    expect(del.status).toBe(200);

    // The transport map entry was reaped, not leaked: the session id is now unknown to DELETE and GET alike.
    const delAgain = await fetch(`${testServer.baseUrl}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
    expect(delAgain.status).toBe(400);
    const get = await fetch(`${testServer.baseUrl}/mcp`, {
      headers: { "mcp-session-id": sessionId, accept: "text/event-stream" }
    });
    expect(get.status).toBe(400);

    await client.close();
  });

  it("closes the run's MCP transport and deletes its .mcp.json when the conversation is stopped", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl);
    expect((await postMessage(testServer.baseUrl, conversationId, "Materialize run.")).status).toBe(200);
    const runId = latestRunId(testServer.server);
    const configPath = path.join(testServer.runtimeRoot, runId, ".mcp.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      readonly mcpServers: { readonly planforge: { readonly url: string } };
    };

    // Connect exactly as the architect CLI would: through the per-run config URL (carries ?runId).
    const transport = new StreamableHTTPClientTransport(new URL(config.mcpServers.planforge.url));
    const client = new Client({ name: "planforge-mcp-teardown-test", version: "0.0.0" });
    await client.connect(transport);
    const sessionId = transport.sessionId ?? "";
    expect(sessionId).not.toBe("");

    const stop = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}/stop`, { method: "POST" });
    expect(stop.status).toBe(200);

    // Teardown closed the transport server-side even though this client never sent a DELETE.
    const del = await fetch(`${testServer.baseUrl}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
    expect(del.status).toBe(400);
    // And the run's on-disk .mcp.json residue is removed (fire-and-forget, so poll briefly).
    await waitFor(() => !existsSync(configPath));
    await client.close();
  });

  it("does not retain an MCP transport whose initialize lands after the conversation was torn down", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl);
    expect((await postMessage(testServer.baseUrl, conversationId, "Materialize run.")).status).toBe(200);
    const runId = latestRunId(testServer.server);
    const config = JSON.parse(await readFile(path.join(testServer.runtimeRoot, runId, ".mcp.json"), "utf8")) as {
      readonly mcpServers: { readonly planforge: { readonly url: string } };
    };

    // Tear the conversation down FIRST: the orchestrator cancels the run and drains this run's
    // transports. An architect initialize completing after that drain used to re-populate the
    // transports map with an entry nothing would ever close again.
    const stop = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}/stop`, { method: "POST" });
    expect(stop.status).toBe(200);

    // Late initialize through the per-run config URL (?runId of the now-dead run). The initialize
    // response itself still completes (the guard skips registration rather than closing mid-request),
    // but the session is never retained, so the client's follow-up initialized-notification hits an
    // unknown session — connect() may resolve or reject. The handed-out session id is the evidence.
    const transport = new StreamableHTTPClientTransport(new URL(config.mcpServers.planforge.url));
    const client = new Client({ name: "planforge-mcp-late-init-test", version: "0.0.0" });
    const sessionId = await client.connect(transport).then(
      () => transport.sessionId ?? "",
      () => transport.sessionId ?? ""
    );
    expect(sessionId).not.toBe("");

    // The guard never stored the late transport: the session id the initialize handed out is
    // unknown server-side, so nothing leaked for process life.
    const del = await fetch(`${testServer.baseUrl}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
    expect(del.status).toBe(400);
    await client.close().catch(() => undefined);
  });

  it("rejects a cross-origin POST to a mutating route and runs no side effect", async () => {
    const testServer = await startTestServer();

    const before = await json<{ readonly conversations: readonly unknown[] }>(
      await fetch(`${testServer.baseUrl}/api/conversations`)
    );
    expect(before.conversations).toHaveLength(0);

    const forbidden = await fetch(`${testServer.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ title: "Driven by a rebinding page" })
    });
    expect(forbidden.status).toBe(403);
    await expect(json(forbidden)).resolves.toMatchObject({ ok: false, code: "E_FORBIDDEN_ORIGIN" });

    // The conversation was never created.
    const after = await json<{ readonly conversations: readonly unknown[] }>(
      await fetch(`${testServer.baseUrl}/api/conversations`)
    );
    expect(after.conversations).toHaveLength(0);
  });

  it("allows a mutating POST with no Origin and with an allowed localhost Origin", async () => {
    const testServer = await startTestServer();

    const noOrigin = await fetch(`${testServer.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "CLI / same-process" })
    });
    expect(noOrigin.status).toBe(200);

    const sameOrigin = await fetch(`${testServer.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: testServer.baseUrl },
      body: JSON.stringify({ title: "SPA same-origin fetch" })
    });
    expect(sameOrigin.status).toBe(200);

    const list = await json<{ readonly conversations: readonly unknown[] }>(
      await fetch(`${testServer.baseUrl}/api/conversations`)
    );
    expect(list.conversations).toHaveLength(2);
  });

  it("allows a same-origin POST when the Host is a non-loopback name (tailnet-served SPA)", async () => {
    const testServer = await startTestServer();
    const port = testServer.server.port;
    const rawPost = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/api/conversations",
            method: "POST",
            headers: { "content-type": "application/json", ...headers }
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on("error", reject);
        req.end(JSON.stringify({ title: "tailnet" }));
      });

    // Served over the tailnet: the page's Host and Origin share the MagicDNS host → same-origin → allowed.
    expect(await rawPost({ host: "studio.tailnet.example", origin: "https://studio.tailnet.example" })).toBe(200);
    // Same Host but an attacker Origin (DNS rebinding) → still rejected.
    expect(await rawPost({ host: "studio.tailnet.example", origin: "https://evil.example" })).toBe(403);
  });

  it("does not gate GET/SSE reads on Origin", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl);

    const list = await fetch(`${testServer.baseUrl}/api/conversations`, {
      headers: { origin: "https://evil.example" }
    });
    expect(list.status).toBe(200);

    const events = await fetchWithLabel(
      `${testServer.baseUrl}/api/conversations/${conversationId}/events`,
      { headers: { origin: "https://evil.example" } },
      "cross-origin events read"
    );
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    await events.body?.cancel();
  });

  it("exposes MCP tools and shares the registry with conversation approval", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl);
    const message = await postMessage(testServer.baseUrl, conversationId, "Materialize run.");
    expect(message.status).toBe(200);
    const runId = latestRunId(testServer.server);
    const client = new Client({ name: "planforge-conversation-http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${testServer.baseUrl}/mcp`)));
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "handoff_to_codex",
        "propose_plan",
        "read_repo_file",
        "sign_off"
      ]);
      const missingRun = await client.callTool({
        name: "propose_plan",
        arguments: {
          runId: "missing-run",
          title: "Missing run",
          plan: "This must not create a pending approval."
        }
      });
      expect(missingRun.isError).toBe(true);
      const missingRunContent = Array.isArray(missingRun.content) ? missingRun.content : [];
      expect(missingRunContent[0]).toMatchObject({ type: "text" });
      if (missingRunContent[0]?.type === "text") {
        expect(missingRunContent[0].text).toContain("E_RUN_NOT_FOUND");
      }
      expect(testServer.server.registry.pendingApprovalsCount()).toBe(0);

      const pending = client.callTool({
        name: "propose_plan",
        arguments: {
          runId,
          title: "Shared registry",
          plan: "Approve through the conversation route."
        }
      });
      await waitFor(() => testServer.server.registry.pendingApprovalsCount() === 1);
      const approve = await postApprove(testServer.baseUrl, conversationId, { verdict: "approved" });
      expect(approve.status).toBe(200);
      const result = await pending;
      const content = Array.isArray(result.content) ? result.content : [];
      const firstContent = content[0];
      expect(firstContent).toMatchObject({ type: "text" });
      if (firstContent?.type === "text") {
        expect(JSON.parse(firstContent.text)).toMatchObject({ runId, verdict: "approved" });
      }
    } finally {
      await client.close();
    }
  });

  it("renames a conversation via PATCH and reflects it in the list", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl, "Old name");

    const response = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "  Shaped name  " })
    });
    expect(response.status).toBe(200);
    const body = await json<{ readonly conversation: { readonly title: string } }>(response);
    expect(body.conversation.title).toBe("Shaped name");

    const list = await json<{ readonly conversations: readonly { readonly id: string; readonly title: string }[] }>(
      await fetch(`${testServer.baseUrl}/api/conversations`)
    );
    expect(list.conversations.find((entry) => entry.id === conversationId)?.title).toBe("Shaped name");
  });

  it("rejects an invalid rename body with a 400 and leaves the title unchanged", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl, "Keep me");

    const empty = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "   " })
    });
    expect(empty.status).toBe(400);
    await expect(json(empty)).resolves.toMatchObject({ ok: false, code: "E_INVALID_CONVERSATION_REQUEST" });

    const list = await json<{ readonly conversations: readonly { readonly id: string; readonly title: string }[] }>(
      await fetch(`${testServer.baseUrl}/api/conversations`)
    );
    expect(list.conversations.find((entry) => entry.id === conversationId)?.title).toBe("Keep me");
  });

  it("soft-deletes via DELETE (archive), hides from the default list, and restores via POST /restore", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl, "To archive");

    const del = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    await expect(json(del)).resolves.toMatchObject({ ok: true, archived: true });

    const live = await json<{ readonly conversations: readonly { readonly id: string }[] }>(
      await fetch(`${testServer.baseUrl}/api/conversations`)
    );
    expect(live.conversations.some((entry) => entry.id === conversationId)).toBe(false);

    const archived = await json<{ readonly conversations: readonly { readonly id: string; readonly archived: boolean }[] }>(
      await fetch(`${testServer.baseUrl}/api/conversations?includeArchived=true`)
    );
    const archivedRow = archived.conversations.find((entry) => entry.id === conversationId);
    expect(archivedRow).toBeDefined();
    expect(archivedRow?.archived).toBe(true);

    const restore = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}/restore`, { method: "POST" });
    expect(restore.status).toBe(200);
    const restored = await json<{ readonly conversation: { readonly archived: boolean } }>(restore);
    expect(restored.conversation.archived).toBe(false);

    const liveAgain = await json<{ readonly conversations: readonly { readonly id: string }[] }>(
      await fetch(`${testServer.baseUrl}/api/conversations`)
    );
    expect(liveAgain.conversations.some((entry) => entry.id === conversationId)).toBe(true);
  });

  it("returns 404 when renaming or archiving an unknown conversation", async () => {
    const testServer = await startTestServer();

    const rename = await fetch(`${testServer.baseUrl}/api/conversations/${knownMissingConversationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Ghost" })
    });
    expect(rename.status).toBe(404);
    await expect(json(rename)).resolves.toMatchObject({ code: "E_CONVERSATION_NOT_FOUND" });

    const del = await fetch(`${testServer.baseUrl}/api/conversations/${knownMissingConversationId}`, { method: "DELETE" });
    expect(del.status).toBe(404);
    await expect(json(del)).resolves.toMatchObject({ code: "E_CONVERSATION_NOT_FOUND" });
  });

  it("rejects a cross-origin PATCH and DELETE with no side effect", async () => {
    const testServer = await startTestServer();
    const conversationId = await createConversation(testServer.baseUrl, "Guarded");

    for (const method of ["PATCH", "DELETE"] as const) {
      const body = method === "PATCH" ? { title: "Hijacked" } : undefined;
      const forbidden = await fetch(`${testServer.baseUrl}/api/conversations/${conversationId}`, {
        method,
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: body ? JSON.stringify(body) : undefined
      });
      expect(forbidden.status).toBe(403);
      await expect(json(forbidden)).resolves.toMatchObject({ ok: false, code: "E_FORBIDDEN_ORIGIN" });
    }

    // Neither the rename nor the archive landed.
    const list = await json<{ readonly conversations: readonly { readonly id: string; readonly title: string; readonly archived: boolean }[] }>(
      await fetch(`${testServer.baseUrl}/api/conversations?includeArchived=true`)
    );
    const row = list.conversations.find((entry) => entry.id === conversationId);
    expect(row?.title).toBe("Guarded");
    expect(row?.archived).toBe(false);
  });
});

describe("PlanForge target selection", () => {
  it("GET /api/config surfaces the configured default target and the allowlisted choices", async () => {
    // Build a temp estate with one allowlisted project so the picker has a real entry.
    const root = await tempRoot();
    const workspaceRoot = root;
    const targetRepo = path.join(workspaceRoot, "projects", "products", "demo");
    await mkdir(path.join(targetRepo, ".git"), { recursive: true });
    const runtimeRoot = path.join(root, "runtime");
    const server = await listenPlanForgeServer({
      port: 0,
      workspaceRoot,
      loopConfig: { targetRepo, runtimeRoot, env: { PATH: "/usr/bin" }, verifierCommands: [{ name: "v", command: "npm test" }] },
      startSession: makeFakeStartSession([])
    });
    servers.push(server);
    const baseUrl = `http://${server.host}:${server.port}`;

    const config = await json<{ readonly targetRepo: string | null; readonly allowedTargets: readonly { readonly path: string; readonly label: string }[] }>(
      await fetch(`${baseUrl}/api/config`)
    );
    expect(config.targetRepo).toBe(targetRepo);
    const labels = config.allowedTargets.map((target) => target.label);
    expect(labels).toContain("products/demo");
  });

  it("creates a conversation with an allowlisted per-conversation target and rejects a disallowed one", async () => {
    const root = await tempRoot();
    const workspaceRoot = root;
    const allowed = path.join(workspaceRoot, "projects", "research", "oracle");
    await mkdir(path.join(allowed, ".git"), { recursive: true });
    const runtimeRoot = path.join(root, "runtime");
    const targetRepo = path.join(root, "target");
    await mkdir(targetRepo, { recursive: true });
    const server = await listenPlanForgeServer({
      port: 0,
      workspaceRoot,
      loopConfig: { targetRepo, runtimeRoot, env: { PATH: "/usr/bin" }, verifierCommands: [{ name: "v", command: "npm test" }] },
      startSession: makeFakeStartSession([])
    });
    servers.push(server);
    const baseUrl = `http://${server.host}:${server.port}`;

    const created = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetRepo: allowed })
    });
    expect(created.status).toBe(200);
    const createdBody = await json<{ readonly id: string }>(created);
    const list = await json<{ readonly conversations: readonly { readonly id: string; readonly targetRepo: string | null }[] }>(
      await fetch(`${baseUrl}/api/conversations`)
    );
    expect(list.conversations.find((row) => row.id === createdBody.id)?.targetRepo).toBe(allowed);

    // A disallowed target is rejected at create time (HTTP 400), never persisted.
    const disallowed = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetRepo: "/etc/passwd" })
    });
    expect(disallowed.status).toBe(400);
    await expect(json(disallowed)).resolves.toMatchObject({ ok: false, code: "E_TARGET_NOT_ALLOWLISTED" });
  });

  it("re-points a not-yet-started conversation to an allowlisted target via PATCH", async () => {
    const root = await tempRoot();
    const workspaceRoot = root;
    const allowed = path.join(workspaceRoot, "projects", "research", "oracle");
    await mkdir(path.join(allowed, ".git"), { recursive: true });
    const runtimeRoot = path.join(root, "runtime");
    const targetRepo = path.join(root, "target");
    await mkdir(targetRepo, { recursive: true });
    const server = await listenPlanForgeServer({
      port: 0,
      workspaceRoot,
      loopConfig: { targetRepo, runtimeRoot, env: { PATH: "/usr/bin" }, verifierCommands: [{ name: "v", command: "npm test" }] },
      startSession: makeFakeStartSession([])
    });
    servers.push(server);
    const baseUrl = `http://${server.host}:${server.port}`;

    const id = await createConversation(baseUrl, "Retarget me");
    const patch = await fetch(`${baseUrl}/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetRepo: allowed })
    });
    expect(patch.status).toBe(200);
    await expect(json<{ readonly conversation: { readonly targetRepo: string | null } }>(patch)).resolves.toMatchObject({
      conversation: { targetRepo: allowed }
    });

    const list = await json<{ readonly conversations: readonly { readonly id: string; readonly targetRepo: string | null }[] }>(
      await fetch(`${baseUrl}/api/conversations`)
    );
    expect(list.conversations.find((row) => row.id === id)?.targetRepo).toBe(allowed);
  });

  it("rejects a PATCH retarget to a disallowed repo with 400 and no persistence", async () => {
    const root = await tempRoot();
    const workspaceRoot = root;
    const runtimeRoot = path.join(root, "runtime");
    const targetRepo = path.join(root, "target");
    await mkdir(targetRepo, { recursive: true });
    const server = await listenPlanForgeServer({
      port: 0,
      workspaceRoot,
      loopConfig: { targetRepo, runtimeRoot, env: { PATH: "/usr/bin" }, verifierCommands: [{ name: "v", command: "npm test" }] },
      startSession: makeFakeStartSession([])
    });
    servers.push(server);
    const baseUrl = `http://${server.host}:${server.port}`;

    const id = await createConversation(baseUrl, "Guarded target");
    const patch = await fetch(`${baseUrl}/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetRepo: "/etc/passwd" })
    });
    expect(patch.status).toBe(400);
    await expect(json(patch)).resolves.toMatchObject({ ok: false, code: "E_TARGET_NOT_ALLOWLISTED" });

    const list = await json<{ readonly conversations: readonly { readonly id: string; readonly targetRepo: string | null }[] }>(
      await fetch(`${baseUrl}/api/conversations`)
    );
    expect(list.conversations.find((row) => row.id === id)?.targetRepo).toBeNull();
  });

  it("locks the target once the conversation has started: PATCH retarget returns 409", async () => {
    const root = await tempRoot();
    const workspaceRoot = root;
    const allowed = path.join(workspaceRoot, "projects", "research", "oracle");
    await mkdir(path.join(allowed, ".git"), { recursive: true });
    const runtimeRoot = path.join(root, "runtime");
    const targetRepo = path.join(root, "target");
    await mkdir(targetRepo, { recursive: true });
    const server = await listenPlanForgeServer({
      port: 0,
      workspaceRoot,
      loopConfig: { targetRepo, runtimeRoot, env: { PATH: "/usr/bin" }, verifierCommands: [{ name: "v", command: "npm test" }] },
      startSession: makeFakeStartSession([])
    });
    servers.push(server);
    const baseUrl = `http://${server.host}:${server.port}`;

    const id = await createConversation(baseUrl, "Already building");
    // The first message starts the architect session, which durably marks the conversation started.
    expect((await postMessage(baseUrl, id, "begin")).status).toBe(200);

    const patch = await fetch(`${baseUrl}/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetRepo: allowed })
    });
    expect(patch.status).toBe(409);
    await expect(json(patch)).resolves.toMatchObject({ ok: false, code: "E_SESSION_ALREADY_STARTED" });
  });
});
