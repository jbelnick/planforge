import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexRunner, GitRunner } from "../src/builder/codex-driver";
import { createPlanForgeRegistry } from "../src/registry";
import { createPlanForgeRunBuilder } from "../src/run-builder";
import { createChatRunService, type JsonValue, type SseClient } from "../src/run-service";
import { createPlanForgeLoopConfig } from "../src/start-server";
import type { VerifierCommandRunner } from "../src/verifier";
import {
  DEFAULT_VERIFIER_TIMEOUT_MS,
  MAX_SPEC_BYTES,
  readTargetVerifierSpec,
  VERIFIER_SPEC_FILENAME
} from "../src/verifier-spec";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function tempTargetRepo(spec?: string): Promise<string> {
  const dir = await tempDir("planforge-verify-spec-");
  if (spec !== undefined) {
    await writeFile(path.join(dir, VERIFIER_SPEC_FILENAME), spec, "utf8");
  }
  return dir;
}

// An allowlist-valid target: a standalone git repo under `projects/<bucket>/` inside a fresh
// workspace, so the run-builder's run-start re-validation (assertAllowedTargetRepo) passes. Returns
// the workspaceRoot to thread into the builder alongside the target.
async function tempAllowlistedTargetRepo(spec?: string): Promise<{ workspaceRoot: string; targetRepo: string }> {
  const workspaceRoot = await tempDir("planforge-verify-ws-");
  const targetRepo = path.join(workspaceRoot, "projects", "products", "fixture");
  await mkdir(path.join(targetRepo, ".git"), { recursive: true });
  if (spec !== undefined) {
    await writeFile(path.join(targetRepo, VERIFIER_SPEC_FILENAME), spec, "utf8");
  }
  return { workspaceRoot, targetRepo };
}

describe("readTargetVerifierSpec parsing", () => {
  it("parses a valid spec (trimmed strings, timeoutMs threaded)", async () => {
    const targetRepo = await tempTargetRepo(
      JSON.stringify({
        verifiers: [
          { name: "  pytest  ", command: " pytest -q " },
          { name: "lint", command: "ruff check ." }
        ],
        timeoutMs: 120_000
      })
    );

    await expect(readTargetVerifierSpec(targetRepo)).resolves.toEqual({
      source: "spec",
      commands: [
        { name: "pytest", command: "pytest -q" },
        { name: "lint", command: "ruff check ." }
      ],
      timeoutMs: 120_000
    });
  });

  it("parses a valid spec without timeoutMs (no timeout key in the resolution)", async () => {
    const targetRepo = await tempTargetRepo(JSON.stringify({ verifiers: [{ name: "go", command: "go test ./..." }] }));

    await expect(readTargetVerifierSpec(targetRepo)).resolves.toEqual({
      source: "spec",
      commands: [{ name: "go", command: "go test ./..." }]
    });
  });

  it("reports absent when the target repo has no spec file", async () => {
    const targetRepo = await tempTargetRepo();
    await expect(readTargetVerifierSpec(targetRepo)).resolves.toEqual({ source: "absent" });
  });

  it("reports absent when the target repo path itself does not exist", async () => {
    await expect(readTargetVerifierSpec("/nonexistent/planforge-fixture")).resolves.toEqual({ source: "absent" });
  });

  it("rejects malformed JSON with the parse error", async () => {
    const targetRepo = await tempTargetRepo('{"verifiers": [');
    const resolution = await readTargetVerifierSpec(targetRepo);
    expect(resolution.source).toBe("invalid");
    expect(resolution).toMatchObject({ reason: expect.stringContaining("not valid JSON") });
  });

  it("rejects a non-object spec", async () => {
    const targetRepo = await tempTargetRepo('["npm test"]');
    await expect(readTargetVerifierSpec(targetRepo)).resolves.toMatchObject({ source: "invalid" });
  });

  it("rejects an empty verifiers array", async () => {
    const targetRepo = await tempTargetRepo(JSON.stringify({ verifiers: [] }));
    const resolution = await readTargetVerifierSpec(targetRepo);
    expect(resolution).toMatchObject({ source: "invalid", reason: expect.stringContaining("verifiers") });
  });

  it("rejects an oversized verifier list (more than 8 entries)", async () => {
    const verifiers = Array.from({ length: 9 }, (_, index) => ({ name: `v${index}`, command: `check ${index}` }));
    const targetRepo = await tempTargetRepo(JSON.stringify({ verifiers }));
    await expect(readTargetVerifierSpec(targetRepo)).resolves.toMatchObject({ source: "invalid" });
  });

  it("rejects blank names and commands", async () => {
    const targetRepo = await tempTargetRepo(JSON.stringify({ verifiers: [{ name: "tests", command: "   " }] }));
    await expect(readTargetVerifierSpec(targetRepo)).resolves.toMatchObject({ source: "invalid" });
  });

  it("rejects unknown keys instead of silently ignoring a typo", async () => {
    const targetRepo = await tempTargetRepo(
      JSON.stringify({ verifers: [{ name: "tests", command: "npm test" }], verifiers: [{ name: "tests", command: "npm test" }] })
    );
    const resolution = await readTargetVerifierSpec(targetRepo);
    expect(resolution).toMatchObject({ source: "invalid", reason: expect.stringContaining("verifers") });
  });

  it("rejects a timeoutMs above the server default cap", async () => {
    const targetRepo = await tempTargetRepo(
      JSON.stringify({ verifiers: [{ name: "tests", command: "npm test" }], timeoutMs: DEFAULT_VERIFIER_TIMEOUT_MS + 1 })
    );
    await expect(readTargetVerifierSpec(targetRepo)).resolves.toMatchObject({
      source: "invalid",
      reason: expect.stringContaining("timeoutMs")
    });
  });

  it("rejects a non-integer timeoutMs", async () => {
    const targetRepo = await tempTargetRepo(JSON.stringify({ verifiers: [{ name: "tests", command: "npm test" }], timeoutMs: 5.5 }));
    await expect(readTargetVerifierSpec(targetRepo)).resolves.toMatchObject({ source: "invalid" });
  });

  it("rejects an oversized spec file on stat BEFORE reading/parsing it", async () => {
    // Not valid JSON: if the size cap is enforced only after readFile+parse, this would surface a
    // "not valid JSON" reason. The stat-first cap must reject it as oversized without ever reading it.
    const oversized = "x".repeat(MAX_SPEC_BYTES + 1);
    const targetRepo = await tempTargetRepo(oversized);
    await expect(readTargetVerifierSpec(targetRepo)).resolves.toEqual({
      source: "invalid",
      reason: `file exceeds ${MAX_SPEC_BYTES} bytes`
    });
  });

  it("fails closed (invalid, not absent) when the spec file exists but is unreadable", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return; // root bypasses file permissions; the branch is untestable there.
    }
    const targetRepo = await tempTargetRepo(JSON.stringify({ verifiers: [{ name: "tests", command: "npm test" }] }));
    await chmod(path.join(targetRepo, VERIFIER_SPEC_FILENAME), 0o000);
    await expect(readTargetVerifierSpec(targetRepo)).resolves.toMatchObject({
      source: "invalid",
      reason: expect.stringContaining("unreadable")
    });
  });

  it("accepts this repo's committed dogfood spec (build + tests + typecheck)", async () => {
    const resolution = await readTargetVerifierSpec(path.resolve(import.meta.dirname, ".."));
    expect(resolution.source).toBe("spec");
    if (resolution.source === "spec") {
      expect(resolution.commands.map((command) => command.name)).toEqual([
        "planforge build",
        "planforge tests",
        "planforge typecheck"
      ]);
      // The served Vite bundle is gated: the build verifier runs `npm run build` (tsc && vite build).
      expect(resolution.commands[0]?.command).toContain("npm run build");
      expect(resolution.commands[2]?.command).toBe("npx tsc -p tsconfig.json --noEmit");
    }
  });
});

type EmittedFrame = {
  readonly event: string;
  readonly data: JsonValue;
};

function recordingClient(frames: EmittedFrame[]): SseClient {
  return {
    send(event, data) {
      frames.push({ event, data });
    },
    end() {},
    cleanup() {}
  };
}

type BuildHarnessInput = {
  readonly runId: string;
  readonly targetRepo: string;
  // Estate root for the run-start target re-validation. When set, the run-builder re-asserts the
  // target against this root before building (mirrors production wiring).
  readonly workspaceRoot?: string;
  readonly codexRunner?: CodexRunner;
  readonly verifierRunner?: VerifierCommandRunner;
};

async function buildHarness(input: BuildHarnessInput) {
  const runService = createChatRunService({ idFactory: () => input.runId });
  const run = runService.create();
  const frames: EmittedFrame[] = [];
  runService.subscribe(run, recordingClient(frames));

  const runtimeRoot = path.join(await tempDir("planforge-verify-runtime-"), "runtime");
  const worktreePath = path.join(runtimeRoot, "worktrees", run.id);
  const codexCalls: string[] = [];
  const codexRunner: CodexRunner =
    input.codexRunner ??
    (async (request) => {
      codexCalls.push(request.resultFile);
      await mkdir(worktreePath, { recursive: true });
      request.onChunk("codex patch\n");
      await writeFile(request.resultFile, "done\n", "utf8");
      return { exitCode: 0 };
    });
  const git: GitRunner = async () => ({ stdout: "", stderr: "" });
  const verifiedCommands: { readonly command: string; readonly cwd: string }[] = [];
  const verifierRunner: VerifierCommandRunner =
    input.verifierRunner ??
    (async (command, cwd) => {
      verifiedCommands.push({ command, cwd });
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    });
  const loopConfig = {
    targetRepo: input.targetRepo,
    runtimeRoot,
    env: { PATH: "/usr/bin" },
    verifierCommands: [{ name: "loop-config verifier", command: "loop-config check" }]
  };
  const runBuilder = createPlanForgeRunBuilder({
    runService,
    loopConfig,
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
    codexRunner,
    git,
    verifierRunner
  });
  const registry = createPlanForgeRegistry({ runBuilder });
  const handoff = () =>
    registry.handoffToCodex({
      runId: run.id,
      project: input.targetRepo,
      objective: "exercise verifier spec resolution",
      context: "fixture",
      constraints: "none",
      verification: ["spec"],
      stop_conditions: ["stop"]
    });
  return { run, frames, worktreePath, codexCalls, verifiedCommands, handoff };
}

describe("run-builder verifier spec resolution", () => {
  it("a target spec takes precedence over the loop-config (env/default) verifiers", async () => {
    const { workspaceRoot, targetRepo } = await tempAllowlistedTargetRepo(
      JSON.stringify({
        verifiers: [
          { name: "spec verifier one", command: "spec check one" },
          { name: "spec verifier two", command: "spec check two" }
        ]
      })
    );
    const harness = await buildHarness({ runId: "run-spec-precedence", targetRepo, workspaceRoot });

    const result = await harness.handoff();

    expect(result.status).toBe("pass");
    expect(result.verifierResults.map((verifier) => verifier.name)).toEqual(["spec verifier one", "spec verifier two"]);
    expect(harness.verifiedCommands.map((call) => call.command)).toEqual(["spec check one", "spec check two"]);
    expect(harness.verifiedCommands.every((call) => call.cwd === harness.worktreePath)).toBe(true);
  });

  it("falls back to the loop-config verifiers when the target has no spec", async () => {
    const { workspaceRoot, targetRepo } = await tempAllowlistedTargetRepo();
    const harness = await buildHarness({ runId: "run-spec-absent", targetRepo, workspaceRoot });

    const result = await harness.handoff();

    expect(result.status).toBe("pass");
    expect(result.verifierResults.map((verifier) => verifier.name)).toEqual(["loop-config verifier"]);
    expect(harness.verifiedCommands.map((call) => call.command)).toEqual(["loop-config check"]);
  });

  it("fails closed on a malformed spec: no build, no verifier run, a clear verifier-spec result", async () => {
    const { workspaceRoot, targetRepo } = await tempAllowlistedTargetRepo('{"verifiers": [');
    const harness = await buildHarness({ runId: "run-spec-fail-closed", targetRepo, workspaceRoot });

    const result = await harness.handoff();

    expect(result.status).toBe("fail");
    expect(result.verifierResults).toEqual([
      {
        name: "verifier-spec",
        status: "fail",
        output: expect.stringContaining("not valid JSON")
      }
    ]);
    expect(harness.codexCalls).toEqual([]);
    expect(harness.verifiedCommands).toEqual([]);
    expect(harness.frames.map((frame) => frame.event)).toEqual(["codex_stream", "verifier_result"]);
    expect(JSON.stringify(harness.frames[0]?.data)).toContain("Build skipped");
    expect(harness.frames[1]?.data).toMatchObject({ status: "fail" });
  });

  it("ignores a spec the builder plants in the worktree (independent read from the target repo)", async () => {
    const { workspaceRoot, targetRepo } = await tempAllowlistedTargetRepo(
      JSON.stringify({ verifiers: [{ name: "target verifier", command: "target check" }] })
    );
    const runId = "run-spec-worktree-plant";
    const harness = await buildHarness({
      runId,
      targetRepo,
      workspaceRoot,
      codexRunner: async (request) => {
        // A malicious builder writes a vacuous spec into its own (builder-writable) worktree —
        // request.cwd IS the build worktree.
        await mkdir(request.cwd, { recursive: true });
        await writeFile(
          path.join(request.cwd, VERIFIER_SPEC_FILENAME),
          JSON.stringify({ verifiers: [{ name: "builder self-grade", command: "true" }] }),
          "utf8"
        );
        request.onChunk("codex patch\n");
        await writeFile(request.resultFile, "done\n", "utf8");
        return { exitCode: 0 };
      }
    });

    const result = await harness.handoff();

    expect(result.verifierResults.map((verifier) => verifier.name)).toEqual(["target verifier"]);
    expect(harness.verifiedCommands.map((call) => call.command)).toEqual(["target check"]);
  });

  it("re-validates the target at run start: a target that lost its .git fails the build before any worktree", async () => {
    // A conversation persisted before the standalone-repo assert existed (or a target whose .git was
    // since removed) resolves to a plain directory. The run-start re-validation must fail the build
    // BEFORE any worktree is created — no codex call, no verifier run.
    const workspaceRoot = await tempDir("planforge-verify-revalidate-");
    const targetRepo = path.join(workspaceRoot, "projects", "products", "fixture");
    await mkdir(targetRepo, { recursive: true }); // no .git → not a standalone repo
    const harness = await buildHarness({ runId: "run-revalidate-fail", targetRepo, workspaceRoot });

    const result = await harness.handoff();

    expect(result.status).toBe("fail");
    expect(result.verifierResults).toEqual([
      {
        name: "target-allowlist",
        status: "fail",
        output: expect.stringContaining("standalone git repo")
      }
    ]);
    expect(harness.codexCalls).toEqual([]);
    expect(harness.verifiedCommands).toEqual([]);
    expect(JSON.stringify(harness.frames[0]?.data)).toContain("re-validation");
  });

  it("snapshots the spec at handoff time: a mid-build rewrite of the target spec does not apply", async () => {
    const { workspaceRoot, targetRepo } = await tempAllowlistedTargetRepo(
      JSON.stringify({ verifiers: [{ name: "handoff-time verifier", command: "handoff-time check" }] })
    );
    const harness = await buildHarness({
      runId: "run-spec-midbuild-rewrite",
      targetRepo,
      workspaceRoot,
      codexRunner: async (request) => {
        await writeFile(
          path.join(targetRepo, VERIFIER_SPEC_FILENAME),
          JSON.stringify({ verifiers: [{ name: "late verifier", command: "late check" }] }),
          "utf8"
        );
        request.onChunk("codex patch\n");
        await writeFile(request.resultFile, "done\n", "utf8");
        return { exitCode: 0 };
      }
    });

    const result = await harness.handoff();

    expect(result.verifierResults.map((verifier) => verifier.name)).toEqual(["handoff-time verifier"]);
    expect(harness.verifiedCommands.map((call) => call.command)).toEqual(["handoff-time check"]);
  });
});

describe("verifier spec timeout threading", () => {
  it("a spec timeoutMs reaches the real runner and group-kills a hung verifier", async () => {
    const { workspaceRoot, targetRepo } = await tempAllowlistedTargetRepo(
      JSON.stringify({
        verifiers: [{ name: "hanging spec verifier", command: 'node -e "setTimeout(() => {}, 30000)"' }],
        timeoutMs: 300
      })
    );
    const runService = createChatRunService({ idFactory: () => "run-spec-timeout" });
    const run = runService.create();
    runService.subscribe(run, recordingClient([]));
    const runtimeRoot = path.join(await tempDir("planforge-verify-timeout-"), "runtime");
    const worktreePath = path.join(runtimeRoot, "worktrees", run.id);
    const codexRunner: CodexRunner = async (request) => {
      await mkdir(worktreePath, { recursive: true });
      request.onChunk("codex patch\n");
      await writeFile(request.resultFile, "done\n", "utf8");
      return { exitCode: 0 };
    };
    const git: GitRunner = async () => ({ stdout: "", stderr: "" });
    const registry = createPlanForgeRegistry({
      runBuilder: createPlanForgeRunBuilder({
        runService,
        loopConfig: {
          targetRepo,
          runtimeRoot,
          env: { PATH: "/usr/bin" },
          verifierCommands: [{ name: "loop-config verifier", command: "loop-config check" }]
          // No loop-config timeout: the 300ms wall below can only come from the target spec.
        },
        workspaceRoot,
        codexRunner,
        git
        // No injected verifierRunner: the REAL runner must receive the spec's timeoutMs.
      })
    });

    const result = await registry.handoffToCodex({
      runId: run.id,
      project: targetRepo,
      objective: "hang the verifier",
      context: "fixture",
      constraints: "none",
      verification: ["spec"],
      stop_conditions: ["stop"]
    });

    expect(result.status).toBe("blocked");
    expect(result.verifierResults[0]).toMatchObject({
      name: "hanging spec verifier",
      status: "blocked",
      exitCode: null,
      output: expect.stringContaining("exceeded the 300ms wall")
    });
  });
});

describe("loop-config verifier precedence (env over default)", () => {
  async function tempWorkspaceWithTarget(): Promise<{ workspaceRoot: string; targetRepo: string }> {
    const workspaceRoot = await tempDir("planforge-verify-workspace-");
    const targetRepo = path.join(workspaceRoot, "projects", "products", "fixture");
    await mkdir(path.join(targetRepo, ".git"), { recursive: true });
    return { workspaceRoot, targetRepo };
  }

  it("PLANFORGE_VERIFIER_* env overrides the built-in default", async () => {
    const { workspaceRoot, targetRepo } = await tempWorkspaceWithTarget();
    const loopConfig = createPlanForgeLoopConfig({
      env: {
        PLANFORGE_TARGET_REPO: targetRepo,
        PLANFORGE_VERIFIER_NAME: "pytest suite",
        PLANFORGE_VERIFIER_COMMAND: "pytest -q"
      },
      workspaceRoot
    });

    expect(loopConfig.verifierCommands).toEqual([{ name: "pytest suite", command: "pytest -q" }]);
  });

  it("without env overrides the built-in default applies", async () => {
    const { workspaceRoot, targetRepo } = await tempWorkspaceWithTarget();
    const loopConfig = createPlanForgeLoopConfig({
      env: { PLANFORGE_TARGET_REPO: targetRepo },
      workspaceRoot
    });

    expect(loopConfig.verifierCommands).toEqual([{ name: "planforge tests", command: "npm test" }]);
    expect(loopConfig.verifierTimeoutMs).toBe(DEFAULT_VERIFIER_TIMEOUT_MS);
  });
});
