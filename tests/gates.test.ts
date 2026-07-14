import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPlanForgeHttpHandler } from "../src/http-server";
import { createChatRunService } from "../src/run-service";
import { createPlanForgeRegistry } from "../src/registry";
import { PlanForgeError } from "../src/errors";
import { createPlanForgeSingleProcessHandler } from "../src/server";
import { createPlanForgeToolHandlers } from "../src/tools";

const servers: Server[] = [];
const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  servers.length = 0;
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function listen(handler: ReturnType<typeof createPlanForgeHttpHandler>) {
  const server = createServer(handler);
  servers.push(server);
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        resolve(`http://127.0.0.1:${address.port}`);
      }
    });
  });
}

async function waitForPendingApproval(registry: ReturnType<typeof createPlanForgeRegistry>) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (registry.pendingApprovalsCount() === 1) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for pending approval.");
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-gates-"));
  tempDirs.push(root);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
}

async function createTrackedFileRepo(): Promise<string> {
  const repo = path.join(await tempRoot(), "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "PlanForge Gates Fixture"]);
  await git(repo, ["config", "user.email", "gates@planforge.local"]);
  await writeFile(path.join(repo, "tracked.txt"), "tracked by git\n", "utf8");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "tracked file"]);
  return repo;
}

describe("PlanForge MCP gate tools", () => {
  it("rejects malformed tool input before any effect", async () => {
    const registry = createPlanForgeRegistry();
    const tools = createPlanForgeToolHandlers({ registry });

    await expect(tools.propose_plan({ runId: "run-1" })).rejects.toThrow(/Invalid propose_plan input/);
    await expect(tools.handoff_to_codex({ runId: "run-1" })).rejects.toThrow(/Invalid handoff_to_codex input/);
    await expect(tools.sign_off({ runId: "run-1" })).rejects.toThrow(/Invalid sign_off input/);

    expect(registry.pendingApprovalsCount()).toBe(0);
    expect(registry.verifierResultsFor("run-1")).toEqual([]);
  });

  it("in-process web approve resolves local propose_plan", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const tools = createPlanForgeToolHandlers({ registry });
    const baseUrl = await listen(createPlanForgeHttpHandler({ registry, runService }));

    const pending = tools.propose_plan({
      runId: "run-approve",
      title: "Tracer plan",
      plan: "Fix the failing fixture test."
    });
    await Promise.resolve();

    expect(registry.pendingApprovalsCount()).toBe(1);

    const response = await fetch(`${baseUrl}/api/runs/run-approve/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "approved", reviewer: "Jason" })
    });

    await expect(response.json()).resolves.toMatchObject({ ok: true, runId: "run-approve" });
    await expect(pending).resolves.toEqual({
      runId: "run-approve",
      verdict: "approved",
      reviewer: "Jason"
    });
    expect(registry.pendingApprovalsCount()).toBe(0);
  });

  it("approve route forwards changes_requested feedback to the pending architect gate", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const tools = createPlanForgeToolHandlers({ registry });
    const baseUrl = await listen(createPlanForgeHttpHandler({ registry, runService }));

    const pending = tools.propose_plan({
      runId: "run-feedback",
      title: "Revision plan",
      plan: "Ask the architect to revise before Codex starts."
    });
    await Promise.resolve();

    const response = await fetch(`${baseUrl}/api/runs/run-feedback/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "changes_requested", feedback: "Narrow the builder handoff." })
    });

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      runId: "run-feedback",
      verdict: "changes_requested"
    });
    await expect(pending).resolves.toEqual({
      runId: "run-feedback",
      verdict: "changes_requested",
      feedback: "Narrow the builder handoff."
    });
    expect(registry.pendingApprovalsCount()).toBe(0);
  });

  it("allows the architect to propose again for the same run after changes are requested", async () => {
    const registry = createPlanForgeRegistry();

    const firstProposal = registry.proposePlan({
      runId: "run-reproposal",
      title: "Initial proposal",
      plan: "First pass needs edits."
    });
    registry.resolveApproval({
      runId: "run-reproposal",
      verdict: "changes_requested",
      feedback: "Clarify verification before handoff."
    });

    await expect(firstProposal).resolves.toEqual({
      runId: "run-reproposal",
      verdict: "changes_requested",
      feedback: "Clarify verification before handoff."
    });

    const revisedProposal = registry.proposePlan({
      runId: "run-reproposal",
      title: "Revised proposal",
      plan: "Second pass addresses feedback."
    });
    registry.resolveApproval({ runId: "run-reproposal", verdict: "approved" });

    await expect(revisedProposal).resolves.toEqual({
      runId: "run-reproposal",
      verdict: "approved"
    });
    expect(registry.pendingApprovalsCount()).toBe(0);
  });

  it("approve resolves propose_plan across the HTTP↔MCP boundary", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const baseUrl = await listen(createPlanForgeSingleProcessHandler({ registry, runService }));
    const client = new Client({ name: "planforge-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    const pending = client.callTool({
      name: "propose_plan",
      arguments: {
        runId: "run-mcp-http",
        title: "Transport plan",
        plan: "Approve over the shared HTTP route."
      }
    });

    await waitForPendingApproval(registry);
    await fetch(`${baseUrl}/api/runs/run-mcp-http/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "approved" })
    });

    const result = await pending;
    const content = Array.isArray(result.content) ? result.content : [];
    const firstContent = content[0];
    expect(firstContent).toMatchObject({ type: "text" });
    if (firstContent?.type === "text") {
      expect(JSON.parse(firstContent.text)).toMatchObject({ runId: "run-mcp-http", verdict: "approved" });
    }
    await client.close();
  });

  it("handoff_to_codex resolves with { status, verifierResults }", async () => {
    const registry = createPlanForgeRegistry({
      runBuilder: async () => ({
        status: "pass",
        verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }]
      })
    });
    const tools = createPlanForgeToolHandlers({ registry });

    await expect(
      tools.handoff_to_codex({
        runId: "run-handoff",
        project: "fixture",
        objective: "Fix failing test",
        context: "Temp repo",
        constraints: "Use Codex worktree",
        verification: ["npm test"],
        stop_conditions: ["Stop after STATUS.md"]
      })
    ).resolves.toEqual({
      status: "pass",
      verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }]
    });

    expect(registry.verifierResultsFor("run-handoff")).toEqual([
      { name: "fixture", status: "pass", exitCode: 0, output: "ok" }
    ]);
  });

  it("stores and retrieves the build's test delta, and evict clears it", async () => {
    const testDelta = {
      weakened: true,
      signals: ["deleted test file: tests/gone.test.ts"],
      addedTests: 0,
      removedTests: 2,
      deletedTestFiles: ["tests/gone.test.ts"]
    };
    const registry = createPlanForgeRegistry({
      runBuilder: async () => ({
        status: "pass",
        verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }],
        testDelta
      })
    });

    // Nothing stored before the build runs.
    expect(registry.testDeltaFor("run-delta")).toBeNull();

    await registry.handoffToCodex({
      runId: "run-delta",
      project: "fixture",
      objective: "Change a feature and its tests",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    });

    expect(registry.testDeltaFor("run-delta")).toEqual(testDelta);
    // Evicting the run (conversation teardown) drops the delta with the rest of the per-run state.
    registry.evict("run-delta");
    expect(registry.testDeltaFor("run-delta")).toBeNull();
  });

  it("stores no test delta when the build result carries none (build never reached a branch)", async () => {
    const registry = createPlanForgeRegistry({
      runBuilder: async () => ({
        status: "fail",
        verifierResults: [{ name: "codex", status: "fail", output: "exit 1" }]
      })
    });

    await registry.handoffToCodex({
      runId: "run-no-delta",
      project: "fixture",
      objective: "Failed build",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    });

    expect(registry.testDeltaFor("run-no-delta")).toBeNull();
  });

  async function driveWeakenedBuild(runId: string, testDelta: {
    readonly weakened: boolean;
    readonly signals: readonly string[];
    readonly addedTests: number;
    readonly removedTests: number;
    readonly deletedTestFiles: readonly string[];
  }) {
    const registry = createPlanForgeRegistry({
      runBuilder: async () => ({
        status: "pass" as const,
        verifierResults: [{ name: "fixture", status: "pass" as const, exitCode: 0, output: "ok" }],
        testDelta
      })
    });
    await registry.handoffToCodex({
      runId,
      project: "fixture",
      objective: "Change a feature and its tests",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    });
    return registry;
  }

  it("blocks sign_off on a weakened test delta without acknowledgment, naming the weakening signals", async () => {
    const registry = await driveWeakenedBuild("run-weak", {
      weakened: true,
      signals: ["deleted test file: tests/gone.test.ts", "added .only() in src/a.test.ts (disables sibling tests): 0 -> 1"],
      addedTests: 0,
      removedTests: 2,
      deletedTestFiles: ["tests/gone.test.ts"]
    });

    // Verifiers all pass, yet the weakened coverage blocks sign_off until it is acknowledged. The
    // thrown message names the signals so the architect must consciously review before re-signing.
    expect(() => registry.signOff({ runId: "run-weak", verdict: "pass", grade: "green but weakened" })).toThrow(
      /deleted test file: tests\/gone\.test\.ts.*added \.only\(\)/s
    );
    expect(() => registry.signOff({ runId: "run-weak", verdict: "pass", grade: "green but weakened" })).toThrow(
      PlanForgeError
    );
  });

  it("allows sign_off on a weakened delta once acknowledgeTestChanges is set (still requires verifiers pass)", async () => {
    const registry = await driveWeakenedBuild("run-weak-ack", {
      weakened: true,
      signals: ["deleted test file: tests/gone.test.ts"],
      addedTests: 0,
      removedTests: 1,
      deletedTestFiles: ["tests/gone.test.ts"]
    });

    const result = registry.signOff({
      runId: "run-weak-ack",
      verdict: "pass",
      grade: "weakening justified: renamed suite",
      acknowledgeTestChanges: true
    });
    expect(result).toEqual({ runId: "run-weak-ack", status: "signed_off", grade: "weakening justified: renamed suite" });
  });

  it("still blocks an acknowledged sign_off when a verifier did not pass", async () => {
    const registry = createPlanForgeRegistry({
      runBuilder: async () => ({
        status: "fail" as const,
        verifierResults: [{ name: "fixture", status: "fail" as const, output: "exit 1" }],
        testDelta: {
          weakened: true,
          signals: ["deleted test file: tests/gone.test.ts"],
          addedTests: 0,
          removedTests: 1,
          deletedTestFiles: ["tests/gone.test.ts"]
        }
      })
    });
    await registry.handoffToCodex({
      runId: "run-weak-failing",
      project: "fixture",
      objective: "Weaken tests on a failing build",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    });

    // The acknowledgment never bypasses the verifier-pass requirement.
    expect(() =>
      registry.signOff({ runId: "run-weak-failing", verdict: "pass", grade: "ack cannot rescue a fail", acknowledgeTestChanges: true })
    ).toThrow(/requires every verifier result/);
  });

  it("needs no acknowledgment for a non-weakened test delta (normal evolution / pure additions)", async () => {
    const registry = await driveWeakenedBuild("run-clean", {
      weakened: false,
      signals: [],
      addedTests: 3,
      removedTests: 0,
      deletedTestFiles: []
    });

    const result = registry.signOff({ runId: "run-clean", verdict: "pass", grade: "clean additions" });
    expect(result).toEqual({ runId: "run-clean", status: "signed_off", grade: "clean additions" });
  });

  it("needs no acknowledgment when the build produced no test delta at all", async () => {
    const registry = createPlanForgeRegistry({
      runBuilder: async () => ({
        status: "pass" as const,
        verifierResults: [{ name: "fixture", status: "pass" as const, exitCode: 0, output: "ok" }]
      })
    });
    await registry.handoffToCodex({
      runId: "run-nodelta-signoff",
      project: "fixture",
      objective: "No test change",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    });

    const result = registry.signOff({ runId: "run-nodelta-signoff", verdict: "pass", grade: "no delta" });
    expect(result).toEqual({ runId: "run-nodelta-signoff", status: "signed_off", grade: "no delta" });
  });

  it("evict tombstones the run so a late build resolution does not re-insert handoff/verifier state", async () => {
    // A mid-build architect crash evicts the run; the builder then resolves AFTER eviction. The late
    // resolution must NOT re-populate the maps evict() cleared, or per-run state leaks back in.
    let releaseBuild: () => void = () => {};
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const registry = createPlanForgeRegistry({
      runBuilder: async () => {
        await buildGate;
        return {
          status: "pass",
          verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }]
        };
      }
    });

    const handoff = registry.handoffToCodex({
      runId: "run-tombstone",
      project: "fixture",
      objective: "Build",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    });

    // The architect crashes mid-build; the conversation is torn down and the run evicted.
    registry.evict("run-tombstone");

    // The builder resolves AFTER eviction. The write-back must be suppressed by the tombstone.
    releaseBuild();
    await handoff;

    expect(registry.handoffResultFor("run-tombstone")).toBeNull();
    expect(registry.verifierResultsFor("run-tombstone")).toEqual([]);
  });

  it("joins a concurrent identical handoff into one build instead of spawning a second worktree", async () => {
    // The transport-drop hazard: the architect re-issues the IDENTICAL handoff while the first build
    // is still in flight. Both calls must resolve to the SAME build; runBuilder runs exactly once.
    let builderCalls = 0;
    let releaseBuild: () => void = () => {};
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const registry = createPlanForgeRegistry({
      runBuilder: async () => {
        builderCalls += 1;
        await buildGate;
        return { status: "pass", verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }] };
      }
    });
    const handoff = {
      runId: "run-join",
      project: "fixture",
      objective: "Build it",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    };

    const first = registry.handoffToCodex(handoff);
    const second = registry.handoffToCodex(handoff);
    releaseBuild();
    const [a, b] = await Promise.all([first, second]);

    expect(builderCalls).toBe(1);
    expect(a).toBe(b);
    expect(a.status).toBe("pass");
  });

  it("returns the cached result for an identical handoff re-issued after the build settled", async () => {
    let builderCalls = 0;
    const registry = createPlanForgeRegistry({
      runBuilder: async () => {
        builderCalls += 1;
        return { status: "pass", verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }] };
      }
    });
    const handoff = {
      runId: "run-cache",
      project: "fixture",
      objective: "Build it",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    };

    await registry.handoffToCodex(handoff);
    await registry.handoffToCodex(handoff);

    expect(builderCalls).toBe(1);
  });

  it("builds fresh for a different objective in the same conversation (distinct cycles stay independent)", async () => {
    let builderCalls = 0;
    const registry = createPlanForgeRegistry({
      runBuilder: async () => {
        builderCalls += 1;
        return { status: "pass", verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }] };
      }
    });
    const base = {
      runId: "run-cycles",
      project: "fixture",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    };

    await registry.handoffToCodex({ ...base, objective: "Build feature A" });
    await registry.handoffToCodex({ ...base, objective: "Build feature B" });

    expect(builderCalls).toBe(2);
  });

  it("re-attempts an identical handoff after the prior build rejected (a throw is not cached)", async () => {
    let builderCalls = 0;
    const registry = createPlanForgeRegistry({
      runBuilder: async () => {
        builderCalls += 1;
        if (builderCalls === 1) {
          throw new Error("codex spawn failed");
        }
        return { status: "pass", verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }] };
      }
    });
    const handoff = {
      runId: "run-reject-retry",
      project: "fixture",
      objective: "Build it",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    };

    await expect(registry.handoffToCodex(handoff)).rejects.toThrow("codex spawn failed");
    await expect(registry.handoffToCodex(handoff)).resolves.toMatchObject({ status: "pass" });
    expect(builderCalls).toBe(2);
  });

  it("rebuilds a byte-identical handoff after the prior cycle completed (cache is cycle-scoped, not conversation-scoped)", async () => {
    // The runId is stable across cycles in one conversation. Without clearing the build cache when a
    // cycle completes, a later cycle whose handoff content is byte-identical to a merged cycle would
    // return the stale already-merged result and silently skip the rebuild. clearBuildCache (called
    // by the orchestrator on cycle_complete) must make the identical re-handoff build fresh.
    let builderCalls = 0;
    const registry = createPlanForgeRegistry({
      runBuilder: async () => {
        builderCalls += 1;
        return { status: "pass", verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }] };
      }
    });
    const handoff = {
      runId: "run-recycle",
      project: "fixture",
      objective: "Build it the same way",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    };

    await registry.handoffToCodex(handoff);
    registry.clearBuildCache("run-recycle");
    await registry.handoffToCodex(handoff);

    expect(builderCalls).toBe(2);
  });

  it("evict clears the in-flight build cache so a later identical handoff builds fresh", async () => {
    let builderCalls = 0;
    const registry = createPlanForgeRegistry({
      runBuilder: async () => {
        builderCalls += 1;
        return { status: "pass", verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }] };
      }
    });
    const handoff = {
      runId: "run-evict-cache",
      project: "fixture",
      objective: "Build it",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    };

    await registry.handoffToCodex(handoff);
    registry.evict("run-evict-cache");
    // After teardown a brand-new conversation could reuse the same content; it must build, not return
    // a stale cached promise for an evicted run.
    await registry.handoffToCodex(handoff).catch(() => undefined);

    expect(builderCalls).toBe(2);
  });

  it("evict aborts the AbortSignal of an in-flight build (operator stop cancels the build)", async () => {
    let capturedSignal: AbortSignal | undefined;
    let releaseBuild: () => void = () => {};
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const registry = createPlanForgeRegistry({
      runBuilder: async (_handoff, options) => {
        capturedSignal = options?.signal;
        await buildGate;
        return { status: "pass", verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }] };
      }
    });

    const build = registry.handoffToCodex({
      runId: "run-abort-signal",
      project: "fixture",
      objective: "Build",
      context: "Temp repo",
      constraints: "Use Codex worktree",
      verification: ["npm test"],
      stop_conditions: ["Stop after STATUS.md"]
    });

    // The build is in flight with a fresh, un-aborted signal handed to the builder.
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    // Teardown (stop / reap / architect-crash) evicts the run — which must abort the in-flight build.
    registry.evict("run-abort-signal");
    expect(capturedSignal?.aborted).toBe(true);

    releaseBuild();
    await build;
  });

  it("handler context resolves the run by runId before starting work", async () => {
    let builderCalls = 0;
    const registry = createPlanForgeRegistry({
      runBuilder: async () => {
        builderCalls += 1;
        return {
          status: "pass",
          verifierResults: [{ name: "fixture", status: "pass", exitCode: 0, output: "ok" }]
        };
      }
    });
    const runService = createChatRunService();
    const tools = createPlanForgeToolHandlers({ registry, runService });

    await expect(
      tools.handoff_to_codex({
        runId: "missing-run",
        project: "fixture",
        objective: "Fix failing test",
        context: "Temp repo",
        constraints: "Use Codex worktree",
        verification: ["npm test"],
        stop_conditions: ["Stop after STATUS.md"]
      })
    ).rejects.toMatchObject({ code: "E_RUN_NOT_FOUND" });

    expect(builderCalls).toBe(0);
    expect(registry.verifierResultsFor("missing-run")).toEqual([]);
  });

  it("read_repo_file returns tracked file content for an existing run", async () => {
    const targetRepo = await createTrackedFileRepo();
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService({ idFactory: () => "run-read-file" });
    const run = runService.create();
    const tools = createPlanForgeToolHandlers({
      registry,
      runService,
      loopConfig: {
        targetRepo,
        runtimeRoot: path.join(targetRepo, ".planforge-runtime"),
        env: { PATH: "/usr/bin" },
        verifierCommands: [{ name: "fixture verifier", command: "npm test" }]
      }
    });

    await expect(tools.read_repo_file({ runId: run.id, path: "tracked.txt" })).resolves.toEqual({
      path: "tracked.txt",
      content: "tracked by git\n",
      truncated: false
    });
  });

  it("read_repo_file rejects an unknown run before reading the repo", async () => {
    const targetRepo = await createTrackedFileRepo();
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const tools = createPlanForgeToolHandlers({
      registry,
      runService,
      loopConfig: {
        targetRepo,
        runtimeRoot: path.join(targetRepo, ".planforge-runtime"),
        env: { PATH: "/usr/bin" },
        verifierCommands: [{ name: "fixture verifier", command: "npm test" }]
      }
    });

    await expect(tools.read_repo_file({ runId: "missing-run", path: "tracked.txt" })).rejects.toMatchObject({
      code: "E_RUN_NOT_FOUND"
    });
  });

  it("MCP lists the exact PlanForge tool set including read_repo_file", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const targetRepo = await createTrackedFileRepo();
    const baseUrl = await listen(
      createPlanForgeSingleProcessHandler({
        registry,
        runService,
        loopConfig: {
          targetRepo,
          runtimeRoot: path.join(targetRepo, ".planforge-runtime"),
          env: { PATH: "/usr/bin" },
          verifierCommands: [{ name: "fixture verifier", command: "npm test" }]
        }
      })
    );
    const client = new Client({ name: "planforge-tools-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    const tools = await client.listTools();
    await client.close();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "handoff_to_codex",
      "propose_plan",
      "read_repo_file",
      "sign_off"
    ]);
  });
});
