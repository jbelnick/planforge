import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexRunner, GitRunner } from "../src/builder/codex-driver";
import type { VerifierCommandRunner } from "../src/verifier";
import { createPlanForgeRunBuilder } from "../src/run-builder";
import { createChatRunService, type JsonValue, type SseClient } from "../src/run-service";
import { createPlanForgeRegistry } from "../src/registry";
import { createPlanForgeToolHandlers } from "../src/tools";

type EmittedFrame = {
  readonly event: string;
  readonly data: JsonValue;
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempRuntimeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-handler-events-"));
  tempDirs.push(root);
  return path.join(root, "runtime");
}

function recordingClient(frames: EmittedFrame[]): SseClient {
  return {
    send(event, data) {
      frames.push({ event, data });
    },
    end() {},
    cleanup() {}
  };
}

describe("PlanForge tool handlers emit loop timeline events", () => {
  it("loop uses the shared registry behaviorally across handlers", async () => {
    const registry = createPlanForgeRegistry({
      runBuilder: async () => ({
        status: "pass",
        verifierResults: [{ name: "fixture verifier", status: "pass", exitCode: 0, output: "ok" }]
      })
    });
    const writer = createPlanForgeToolHandlers({ registry });
    const reader = createPlanForgeToolHandlers({ registry });

    await writer.handoff_to_codex({
      runId: "run-shared-registry",
      project: "fixture",
      objective: "Fix",
      context: "Temp",
      constraints: "None",
      verification: ["npm test"],
      stop_conditions: ["Stop"]
    });

    await expect(
      reader.sign_off({ runId: "run-shared-registry", verdict: "pass", grade: "Second handler saw verifier state." })
    ).resolves.toEqual({
      runId: "run-shared-registry",
      status: "signed_off",
      grade: "Second handler saw verifier state."
    });
  });

  it("sign_off records the acknowledgment on the architect_grade and sign_off events after a weakened build", async () => {
    const runService = createChatRunService({ idFactory: () => "run-ack-events" });
    const run = runService.create();
    const frames: EmittedFrame[] = [];
    runService.subscribe(run, recordingClient(frames));

    const weakenedDelta = {
      weakened: true,
      signals: ["deleted test file: tests/gone.test.ts"],
      addedTests: 0,
      removedTests: 1,
      deletedTestFiles: ["tests/gone.test.ts"]
    };
    const registry = createPlanForgeRegistry({
      runBuilder: async () => ({
        status: "pass",
        verifierResults: [{ name: "fixture verifier", status: "pass", exitCode: 0, output: "ok" }],
        testDelta: weakenedDelta
      })
    });
    const tools = createPlanForgeToolHandlers({ registry, runService });

    await tools.handoff_to_codex({
      runId: run.id,
      project: "fixture",
      objective: "Change a feature and its tests",
      context: "Temp",
      constraints: "None",
      verification: ["npm test"],
      stop_conditions: ["Stop"]
    });

    // Without acknowledgment the weakened delta blocks sign_off and no verdict event is emitted.
    await expect(tools.sign_off({ runId: run.id, verdict: "pass", grade: "green but weakened" })).rejects.toThrow(
      /weakened test coverage/
    );
    expect(frames.some((frame) => frame.event === "sign_off")).toBe(false);
    expect(frames.some((frame) => frame.event === "architect_grade")).toBe(false);

    // Re-signing with the acknowledgment passes and records the audited decision on both events.
    await tools.sign_off({ runId: run.id, verdict: "pass", grade: "weakening justified", acknowledgeTestChanges: true });
    const gradeFrame = frames.find((frame) => frame.event === "architect_grade");
    const signOffFrame = frames.find((frame) => frame.event === "sign_off");
    expect(gradeFrame?.data).toMatchObject({ grade: "weakening justified", acknowledgeTestChanges: true });
    expect(signOffFrame?.data).toMatchObject({ verdict: "pass", acknowledgeTestChanges: true });
  });

  it("records acknowledgeTestChanges:false on the events for an ordinary sign_off", async () => {
    const runService = createChatRunService({ idFactory: () => "run-noack-events" });
    const run = runService.create();
    const frames: EmittedFrame[] = [];
    runService.subscribe(run, recordingClient(frames));

    const registry = createPlanForgeRegistry({
      runBuilder: async () => ({
        status: "pass",
        verifierResults: [{ name: "fixture verifier", status: "pass", exitCode: 0, output: "ok" }]
      })
    });
    const tools = createPlanForgeToolHandlers({ registry, runService });

    await tools.handoff_to_codex({
      runId: run.id,
      project: "fixture",
      objective: "No test change",
      context: "Temp",
      constraints: "None",
      verification: ["npm test"],
      stop_conditions: ["Stop"]
    });
    await tools.sign_off({ runId: run.id, verdict: "pass", grade: "clean" });

    const gradeFrame = frames.find((frame) => frame.event === "architect_grade");
    const signOffFrame = frames.find((frame) => frame.event === "sign_off");
    expect(gradeFrame?.data).toMatchObject({ acknowledgeTestChanges: false });
    expect(signOffFrame?.data).toMatchObject({ acknowledgeTestChanges: false });
  });

  it("runBuilder adapter streams Codex, verifies, and sign_off emits architect verdict", async () => {
    const runService = createChatRunService({ idFactory: () => "run-handler-events" });
    const run = runService.create();
    const frames: EmittedFrame[] = [];
    runService.subscribe(run, recordingClient(frames));

    const runtimeRoot = await tempRuntimeRoot();
    const codexRunner: CodexRunner = async (request) => {
      request.onChunk("codex streamed patch\n");
      await writeFile(request.resultFile, "Codex finished\n", "utf8");
      return { exitCode: 0 };
    };
    // rev-parse HEAD returns a sha (a real repo always resolves HEAD) so the test-delta base is
    // resolvable; the empty diff means no test changes → a non-weakened delta that needs no ack.
    const git: GitRunner = async (args) =>
      args.includes("rev-parse") ? { stdout: "headsha\n", stderr: "" } : { stdout: "", stderr: "" };
    const verifierRunner: VerifierCommandRunner = async (command, cwd) => ({
      exitCode: command === "verify fixture" && cwd.endsWith(path.join("worktrees", run.id)) ? 0 : 1,
      stdout: "fixture ok\n",
      stderr: ""
    });
    const loopConfig = {
      targetRepo: "/tmp/fixture",
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "fixture verifier", command: "verify fixture" }]
    };
    const registry = createPlanForgeRegistry({
      runBuilder: createPlanForgeRunBuilder({
        runService,
        loopConfig,
        validateTarget: () => {},
        codexRunner,
        git,
        verifierRunner
      })
    });
    const tools = createPlanForgeToolHandlers({ registry, runService, loopConfig });

    const approval = tools.propose_plan({
      runId: run.id,
      title: "External architect plan",
      plan: "Approve then build."
    });
    registry.resolveApproval({ runId: run.id, verdict: "approved", reviewer: "Jason" });
    await approval;

    const handoff = await tools.handoff_to_codex({
      runId: run.id,
      project: "/tmp/fixture",
      objective: "Fix fixture",
      context: "Temp repo",
      constraints: "Use worktree",
      verification: ["verify fixture"],
      stop_conditions: ["Stop after STATUS.md"]
    });
    await tools.sign_off({ runId: run.id, verdict: "pass", grade: "Architect saw verifier pass." });

    expect(handoff).toMatchObject({
      status: "pass",
      branch: `planforge/${run.id}`,
      worktreePath: path.join(runtimeRoot, "worktrees", run.id),
      verifierResults: [{ name: "fixture verifier", status: "pass", exitCode: 0, output: "fixture ok" }]
    });
    expect(registry.verifierResultsFor(run.id)).toEqual(handoff.verifierResults);
    expect(frames.map((frame) => frame.event)).toEqual([
      "plan_proposed",
      "codex_stream",
      "codex_stream",
      "codex_stream",
      "build_usage",
      "test_delta",
      "verifier_result",
      "architect_grade",
      "sign_off"
    ]);
    expect(frames[0]?.data).toMatchObject({ title: "External architect plan", plan: "Approve then build." });
    // The build-start context line opens the stream: the effective wall (default 30m here) plus the
    // worktree tail, so the operator knows the budget and which checkout is building.
    expect((frames[1]?.data as { chunk?: string }).chunk).toBe(`PlanForge: build started (wall 30m, worktree ${run.id}).\n`);
    // The build-worktree node_modules link outcome is streamed BEFORE any codex output; the fixture
    // target has no installed node_modules, so operators see the fallback (and its reason).
    expect((frames[2]?.data as { chunk?: string }).chunk).toContain("did not link node_modules into the build worktree");
    expect(frames[3]?.data).toMatchObject({ chunk: "codex streamed patch\n" });
    // The run-builder emits a builder-side usage event (build wall-clock) right after the build
    // settles, so the orchestrator can surface the builder half of the usage showcase.
    expect(frames[4]?.data).toMatchObject({ side: "builder" });
    expect(typeof (frames[4]?.data as { durationMs?: number }).durationMs).toBe("number");
    // The deterministic test-weakening delta is surfaced before the verifier result; no test files
    // changed here, so it is non-weakened.
    expect(frames[5]?.data).toMatchObject({ testDelta: { weakened: false } });
    expect(frames[6]?.data).toMatchObject({ status: "pass", verifierResults: [expect.objectContaining({ name: "fixture verifier" })] });
    expect(frames[7]?.data).toMatchObject({ verdict: "pass", grade: "Architect saw verifier pass." });
    expect(frames[8]?.data).toMatchObject({ verdict: "pass" });
  });

  it("runBuilder build_usage surfaces the configured builder effort + model", async () => {
    const runService = createChatRunService({ idFactory: () => "run-build-usage" });
    const run = runService.create();
    const frames: EmittedFrame[] = [];
    runService.subscribe(run, recordingClient(frames));

    const runtimeRoot = await tempRuntimeRoot();
    const codexArgv: string[][] = [];
    const codexRunner: CodexRunner = async (request) => {
      codexArgv.push([...request.argv]);
      request.onChunk("patch\n");
      await writeFile(request.resultFile, "done\n", "utf8");
      return { exitCode: 0 };
    };
    const git: GitRunner = async () => ({ stdout: "", stderr: "" });
    const verifierRunner: VerifierCommandRunner = async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" });
    const loopConfig = {
      targetRepo: "/tmp/fixture",
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "fixture verifier", command: "verify fixture" }],
      builderEffort: "high" as const,
      builderModel: "glm-5.2"
    };
    const registry = createPlanForgeRegistry({
      runBuilder: createPlanForgeRunBuilder({
        runService,
        loopConfig,
        validateTarget: () => {},
        codexRunner,
        git,
        verifierRunner
      })
    });
    const tools = createPlanForgeToolHandlers({ registry, runService, loopConfig });

    const approval = tools.propose_plan({ runId: run.id, title: "P", plan: "Build." });
    registry.resolveApproval({ runId: run.id, verdict: "approved" });
    await approval;
    await tools.handoff_to_codex({
      runId: run.id,
      project: "/tmp/fixture",
      objective: "Build",
      context: "ctx",
      constraints: "none",
      verification: ["verify fixture"],
      stop_conditions: ["stop"]
    });

    const buildUsage = frames.find((frame) => frame.event === "build_usage");
    expect(buildUsage?.data).toMatchObject({ side: "builder", effort: "high", model: "glm-5.2" });
    expect(typeof (buildUsage?.data as { durationMs?: number }).durationMs).toBe("number");
    // The surfaced effort is the same loop-config value actually passed to Codex.
    expect(codexArgv[0]).toContain('model_reasoning_effort="high"');
  });

  it("links node_modules into the build worktree before codex spawns and streams the link line", async () => {
    const runService = createChatRunService({ idFactory: () => "run-build-deps-link" });
    const run = runService.create();
    const frames: EmittedFrame[] = [];
    runService.subscribe(run, recordingClient(frames));

    const targetRepo = await mkdtemp(path.join(os.tmpdir(), "planforge-build-deps-target-"));
    tempDirs.push(targetRepo);
    await mkdir(path.join(targetRepo, "node_modules", "left-pad"), { recursive: true });
    const runtimeRoot = await tempRuntimeRoot();
    const worktreePath = path.join(runtimeRoot, "worktrees", run.id);

    let sawSymlinkBeforeSpawn = false;
    const codexRunner: CodexRunner = async (request) => {
      // The link must already be in place when codex spawns — the point is that the builder never
      // pays a cold npm ci inside its wall budget.
      sawSymlinkBeforeSpawn = (await lstat(path.join(request.cwd, "node_modules"))).isSymbolicLink();
      request.onChunk("codex streamed patch\n");
      return { exitCode: 0 };
    };
    const git: GitRunner = async (args) => {
      if (args.includes("rev-parse")) {
        return { stdout: `${targetRepo}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const verifierRunner: VerifierCommandRunner = async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" });
    const loopConfig = {
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "fixture verifier", command: "verify fixture" }]
    };
    const registry = createPlanForgeRegistry({
      runBuilder: createPlanForgeRunBuilder({ runService, loopConfig, validateTarget: () => {}, codexRunner, git, verifierRunner })
    });
    const tools = createPlanForgeToolHandlers({ registry, runService, loopConfig });

    const approval = tools.propose_plan({ runId: run.id, title: "P", plan: "Build." });
    registry.resolveApproval({ runId: run.id, verdict: "approved" });
    await approval;

    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const handoff = await tools.handoff_to_codex({
        runId: run.id,
        project: targetRepo,
        objective: "Build",
        context: "ctx",
        constraints: "none",
        verification: ["verify fixture"],
        stop_conditions: ["stop"]
      });
      expect(handoff.status).toBe("pass");
      // The verify-phase call is unchanged; it now finds the build-phase link already in place.
      expect(consoleLog.mock.calls.flat().join("\n")).toContain(
        "did not link verify node_modules (worktree already has node_modules)"
      );
    } finally {
      consoleLog.mockRestore();
    }

    expect(sawSymlinkBeforeSpawn).toBe(true);
    expect(await readlink(path.join(worktreePath, "node_modules"))).toBe(path.join(targetRepo, "node_modules"));
    // The link outcome lands in the same stream codex output uses (build_output transcript
    // entries), BEFORE any codex chunk.
    const linkIndex = frames.findIndex(
      (frame) => frame.event === "codex_stream" && JSON.stringify(frame.data).includes("linked node_modules into the build worktree")
    );
    const codexIndex = frames.findIndex(
      (frame) => frame.event === "codex_stream" && JSON.stringify(frame.data).includes("codex streamed patch")
    );
    expect(linkIndex).toBeGreaterThanOrEqual(0);
    expect(codexIndex).toBeGreaterThan(linkIndex);
  });

  it("streams the build-worktree link fallback (with reason) and still runs the build", async () => {
    const runService = createChatRunService({ idFactory: () => "run-build-deps-fallback" });
    const run = runService.create();
    const frames: EmittedFrame[] = [];
    runService.subscribe(run, recordingClient(frames));

    const runtimeRoot = await tempRuntimeRoot();
    const codexRunner: CodexRunner = async (request) => {
      request.onChunk("codex streamed patch\n");
      return { exitCode: 0 };
    };
    const git: GitRunner = async () => ({ stdout: "", stderr: "" });
    const verifierRunner: VerifierCommandRunner = async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" });
    const loopConfig = {
      // No node_modules to reuse at this target: the build must proceed anyway (best-effort) and
      // the operator must see why it might be slow.
      targetRepo: "/tmp/fixture",
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "fixture verifier", command: "verify fixture" }]
    };
    const registry = createPlanForgeRegistry({
      runBuilder: createPlanForgeRunBuilder({ runService, loopConfig, validateTarget: () => {}, codexRunner, git, verifierRunner })
    });
    const tools = createPlanForgeToolHandlers({ registry, runService, loopConfig });

    const approval = tools.propose_plan({ runId: run.id, title: "P", plan: "Build." });
    registry.resolveApproval({ runId: run.id, verdict: "approved" });
    await approval;

    const handoff = await tools.handoff_to_codex({
      runId: run.id,
      project: "/tmp/fixture",
      objective: "Build",
      context: "ctx",
      constraints: "none",
      verification: ["verify fixture"],
      stop_conditions: ["stop"]
    });

    expect(handoff.status).toBe("pass");
    const fallbackIndex = frames.findIndex(
      (frame) =>
        frame.event === "codex_stream" && JSON.stringify(frame.data).includes("did not link node_modules into the build worktree")
    );
    const codexIndex = frames.findIndex(
      (frame) => frame.event === "codex_stream" && JSON.stringify(frame.data).includes("codex streamed patch")
    );
    expect(fallbackIndex).toBeGreaterThanOrEqual(0);
    // The fallback line carries the reason so a slow cold-install build is explicable.
    expect(JSON.stringify(frames[fallbackIndex]?.data)).toContain("no installed node_modules");
    expect(codexIndex).toBeGreaterThan(fallbackIndex);
  });

  it("aborts a timed-out Codex build to blocked without running the verifier", async () => {
    const runService = createChatRunService({ idFactory: () => "run-build-timeout" });
    const run = runService.create();
    const frames: EmittedFrame[] = [];
    runService.subscribe(run, recordingClient(frames));

    const runtimeRoot = await tempRuntimeRoot();
    const codexRunner: CodexRunner = async (request) => {
      request.onChunk("codex thrashing\n");
      return { exitCode: null, timedOut: "wall", signal: "SIGTERM" };
    };
    const git: GitRunner = async () => ({ stdout: "", stderr: "" });
    let verifierCalls = 0;
    const verifierRunner: VerifierCommandRunner = async () => {
      verifierCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const loopConfig = {
      targetRepo: "/tmp/fixture",
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "fixture verifier", command: "verify fixture" }]
    };
    const registry = createPlanForgeRegistry({
      runBuilder: createPlanForgeRunBuilder({ runService, loopConfig, validateTarget: () => {}, codexRunner, git, verifierRunner })
    });
    const tools = createPlanForgeToolHandlers({ registry, runService, loopConfig });

    const approval = tools.propose_plan({ runId: run.id, title: "P", plan: "Approve then build." });
    registry.resolveApproval({ runId: run.id, verdict: "approved", reviewer: "Jason" });
    await approval;

    const handoff = await tools.handoff_to_codex({
      runId: run.id,
      project: "/tmp/fixture",
      objective: "tiny change",
      context: "Temp repo",
      constraints: "Use worktree",
      verification: ["verify fixture"],
      stop_conditions: ["Stop after STATUS.md"]
    });

    expect(handoff.status).toBe("blocked");
    expect(verifierCalls).toBe(0);
    const verifierFrame = frames.find((frame) => frame.event === "verifier_result");
    expect(verifierFrame?.data).toMatchObject({ status: "blocked" });
    // The wall-kill result names how long the wall was, so the operator reading the verify result
    // knows which knob (PLANFORGE_BUILD_TIMEOUT_MS) to turn.
    expect(verifierFrame?.data).toMatchObject({
      verifierResults: [{ name: "codex", status: "blocked", output: "build timeout: wall (30m)" }]
    });
    expect(frames.some((frame) => frame.event === "sign_off")).toBe(false);
  });

  it("surfaces an aborted (canceled) Codex build as blocked without running the verifier", async () => {
    const runService = createChatRunService({ idFactory: () => "run-build-abort" });
    const run = runService.create();
    const frames: EmittedFrame[] = [];
    runService.subscribe(run, recordingClient(frames));

    const runtimeRoot = await tempRuntimeRoot();
    const codexRunner: CodexRunner = async (request) => {
      request.onChunk("codex working\n");
      return { exitCode: null, aborted: true, signal: "SIGTERM" };
    };
    const git: GitRunner = async () => ({ stdout: "", stderr: "" });
    let verifierCalls = 0;
    const verifierRunner: VerifierCommandRunner = async () => {
      verifierCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const loopConfig = {
      targetRepo: "/tmp/fixture",
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "fixture verifier", command: "verify fixture" }]
    };
    const registry = createPlanForgeRegistry({
      runBuilder: createPlanForgeRunBuilder({ runService, loopConfig, validateTarget: () => {}, codexRunner, git, verifierRunner })
    });
    const tools = createPlanForgeToolHandlers({ registry, runService, loopConfig });

    const approval = tools.propose_plan({ runId: run.id, title: "P", plan: "Approve then build." });
    registry.resolveApproval({ runId: run.id, verdict: "approved", reviewer: "Jason" });
    await approval;

    const handoff = await tools.handoff_to_codex({
      runId: run.id,
      project: "/tmp/fixture",
      objective: "tiny change",
      context: "Temp repo",
      constraints: "Use worktree",
      verification: ["verify fixture"],
      stop_conditions: ["Stop after STATUS.md"]
    });

    expect(handoff.status).toBe("blocked");
    expect(verifierCalls).toBe(0);
    const verifierFrame = frames.find((frame) => frame.event === "verifier_result");
    expect(verifierFrame?.data).toMatchObject({ status: "blocked" });
    expect(frames.some((frame) => frame.event === "codex_stream" && JSON.stringify(frame.data).includes("canceled"))).toBe(true);
    expect(frames.some((frame) => frame.event === "sign_off")).toBe(false);
    // A canceled build can never be signed off (the verifier results are all blocked).
    expect(() => registry.signOff({ runId: run.id, verdict: "pass", grade: "should not pass" })).toThrow(
      /requires every verifier result/
    );
  });

  it("fails the cycle when the Codex build writes outside scope (no verifier, no merge)", async () => {
    const runService = createChatRunService({ idFactory: () => "run-scope-fail" });
    const run = runService.create();
    const frames: EmittedFrame[] = [];
    runService.subscribe(run, recordingClient(frames));

    const runtimeRoot = await tempRuntimeRoot();
    const codexRunner: CodexRunner = async (request) => {
      request.onChunk("codex edited the frozen acceptance contract\n");
      return { exitCode: 0 };
    };
    const worktreePath = path.join(runtimeRoot, "worktrees", run.id);
    const git: GitRunner = async (args) => {
      if (args.join(" ") === `-C ${worktreePath} status --porcelain -z`) {
        // ACCEPTANCE.md is builder-protected forever (the frozen grading contract); a write to it
        // must fail the cycle before verify/merge. (Tests are no longer protected here.)
        return { stdout: " M projects/products/planforge/docs/ACCEPTANCE.md\0", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    let verifierCalls = 0;
    const verifierRunner: VerifierCommandRunner = async () => {
      verifierCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const loopConfig = {
      targetRepo: "/tmp/fixture",
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "fixture verifier", command: "verify fixture" }]
    };
    const registry = createPlanForgeRegistry({
      runBuilder: createPlanForgeRunBuilder({ runService, loopConfig, validateTarget: () => {}, codexRunner, git, verifierRunner })
    });
    const tools = createPlanForgeToolHandlers({ registry, runService, loopConfig });

    const approval = tools.propose_plan({ runId: run.id, title: "P", plan: "Approve then build." });
    registry.resolveApproval({ runId: run.id, verdict: "approved", reviewer: "Jason" });
    await approval;

    const handoff = await tools.handoff_to_codex({
      runId: run.id,
      project: "/tmp/fixture",
      objective: "tiny change",
      context: "Temp repo",
      constraints: "Use worktree",
      verification: ["verify fixture"],
      stop_conditions: ["Stop after STATUS.md"]
    });

    expect(handoff.status).toBe("fail");
    expect(verifierCalls).toBe(0);
    const verifierFrame = frames.find((frame) => frame.event === "verifier_result");
    expect(verifierFrame?.data).toMatchObject({ status: "fail" });
    expect(frames.some((frame) => frame.event === "sign_off")).toBe(false);
  });

  it("fails the cycle on a non-zero Codex exit without running the verifier and cleans up the worktree", async () => {
    const runService = createChatRunService({ idFactory: () => "run-nonzero-exit" });
    const run = runService.create();
    const frames: EmittedFrame[] = [];
    runService.subscribe(run, recordingClient(frames));

    const runtimeRoot = await tempRuntimeRoot();
    const codexRunner: CodexRunner = async (request) => {
      request.onChunk("codex failed mid-build\n");
      return { exitCode: 17 };
    };
    const worktreePath = path.join(runtimeRoot, "worktrees", run.id);
    const gitCalls: string[] = [];
    const git: GitRunner = async (args) => {
      gitCalls.push(args.join(" "));
      return { stdout: "", stderr: "" };
    };
    let verifierCalls = 0;
    const verifierRunner: VerifierCommandRunner = async () => {
      verifierCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const loopConfig = {
      targetRepo: "/tmp/fixture",
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "fixture verifier", command: "verify fixture" }]
    };
    const registry = createPlanForgeRegistry({
      runBuilder: createPlanForgeRunBuilder({ runService, loopConfig, validateTarget: () => {}, codexRunner, git, verifierRunner })
    });
    const tools = createPlanForgeToolHandlers({ registry, runService, loopConfig });

    const approval = tools.propose_plan({ runId: run.id, title: "P", plan: "Approve then build." });
    registry.resolveApproval({ runId: run.id, verdict: "approved", reviewer: "Jason" });
    await approval;

    const handoff = await tools.handoff_to_codex({
      runId: run.id,
      project: "/tmp/fixture",
      objective: "tiny change",
      context: "Temp repo",
      constraints: "Use worktree",
      verification: ["verify fixture"],
      stop_conditions: ["Stop after STATUS.md"]
    });

    expect(handoff.status).toBe("fail");
    expect(verifierCalls).toBe(0);
    const verifierFrame = frames.find((frame) => frame.event === "verifier_result");
    expect(verifierFrame?.data).toMatchObject({ status: "fail" });
    expect(frames.some((frame) => frame.event === "sign_off")).toBe(false);
    // The failed build's worktree is removed, not leaked, mirroring the timeout branch.
    const removeAfterAdd = gitCalls
      .slice(gitCalls.findIndex((call) => call.includes("worktree add")) + 1)
      .filter((call) => call === `-C /tmp/fixture worktree remove --force ${worktreePath}`);
    expect(removeAfterAdd.length).toBeGreaterThanOrEqual(1);
  });

  it("emits a terminal error event (settling buildInFlight) and propagates the original error when the build throws after streaming", async () => {
    const runService = createChatRunService({ idFactory: () => "run-build-throw" });
    const run = runService.create();
    const frames: EmittedFrame[] = [];
    runService.subscribe(run, recordingClient(frames));

    const runtimeRoot = await tempRuntimeRoot();
    const originalError = new Error("post-build git ops blew up");
    const codexRunner: CodexRunner = async (request) => {
      // The build marks itself in flight by streaming, then throws before any terminal run event —
      // exactly the window where the reaper would stay paused forever without run-builder's catch.
      request.onChunk("codex streamed then died\n");
      throw originalError;
    };
    const git: GitRunner = async () => ({ stdout: "", stderr: "" });
    let verifierCalls = 0;
    const verifierRunner: VerifierCommandRunner = async () => {
      verifierCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const loopConfig = {
      targetRepo: "/tmp/fixture",
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      verifierCommands: [{ name: "fixture verifier", command: "verify fixture" }]
    };
    const registry = createPlanForgeRegistry({
      runBuilder: createPlanForgeRunBuilder({ runService, loopConfig, validateTarget: () => {}, codexRunner, git, verifierRunner })
    });
    const tools = createPlanForgeToolHandlers({ registry, runService, loopConfig });

    const approval = tools.propose_plan({ runId: run.id, title: "P", plan: "Approve then build." });
    registry.resolveApproval({ runId: run.id, verdict: "approved", reviewer: "Jason" });
    await approval;

    await expect(
      tools.handoff_to_codex({
        runId: run.id,
        project: "/tmp/fixture",
        objective: "tiny change",
        context: "Temp repo",
        constraints: "Use worktree",
        verification: ["verify fixture"],
        stop_conditions: ["Stop after STATUS.md"]
      })
    ).rejects.toBe(originalError);

    // A codex_stream fired (build in flight), then a terminal error settled it; no verifier ran.
    // (The first two codex_streams are the pre-spawn build-start + node_modules link lines.)
    expect(frames.map((frame) => frame.event)).toEqual(["plan_proposed", "codex_stream", "codex_stream", "codex_stream", "error"]);
    expect(frames.at(-1)?.data).toMatchObject({ message: "post-build git ops blew up" });
    expect(verifierCalls).toBe(0);
    expect(frames.some((frame) => frame.event === "verifier_result")).toBe(false);
  });
});
