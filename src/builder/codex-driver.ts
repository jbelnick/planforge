import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PlanForgeError } from "../errors";
import type { CodexHandoff } from "../domain";
import type { BuilderEffort } from "../effort";
import { copyEnv } from "../shared/env";
import { renderHandoffArtifact } from "./handoff";
import {
  defaultWriteScopePolicy,
  evaluateWriteScope,
  parsePorcelainPaths,
  type WriteScopePolicy,
  type WriteScopeViolation
} from "./write-scope";

export type GitRunner = (args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export type CreateDefaultGitRunnerOptions = {
  readonly maxBufferBytes?: number;
};

// One git runner for every call site. LC_ALL/LANG=C pin stable, parseable porcelain output;
// maxBufferBytes lets large-repo readers (manifest, file) raise the stdout cap above Node's
// 1 MiB default without shrinking any site that needs the headroom.
export function createDefaultGitRunner(options: CreateDefaultGitRunnerOptions = {}): GitRunner {
  return async (args) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync("git", [...args], {
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      ...(options.maxBufferBytes === undefined ? {} : { maxBuffer: options.maxBufferBytes })
    });
    return { stdout: result.stdout, stderr: result.stderr };
  };
}

export type CodexRunRequest = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly resultFile: string;
  readonly eventsFile: string;
  readonly onChunk: (chunk: string) => void;
  readonly timeoutMs?: number;
  readonly silenceMs?: number;
  // Aborting this signal (operator stop / conversation teardown) group-kills the build immediately
  // rather than waiting for the wall, so a stopped run is responsive and leaves no orphaned codex.
  readonly signal?: AbortSignal;
};

export type BuildTimeout = "wall" | "silence";

export type CodexRunResult = {
  readonly exitCode: number | null;
  readonly timedOut?: BuildTimeout;
  readonly aborted?: boolean;
  readonly signal?: NodeJS.Signals | null;
};

// 30 min (PlanBridge parity): a 15-min wall killed real fresh-worktree Node builds that run their own gates.
const DEFAULT_BUILD_TIMEOUT_MS = 1_800_000;
const DEFAULT_BUILD_SILENCE_MS = 300_000;
const SIGKILL_GRACE_MS = 5_000;

export function positiveIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PlanForgeError(
      "E_INVALID_BUILD_TIMEOUT",
      `Build timeout values must be non-negative integers in milliseconds (got "${value}").`
    );
  }
  return parsed;
}

// The effective build wall for a given env — the exact resolution runCodexBuilder applies when no
// explicit timeoutMs is passed. Exported so run-builder can surface the wall in the build stream
// and the wall-timeout verifier output without duplicating the default.
export function resolveBuildWallMs(env: NodeJS.ProcessEnv | Record<string, string | undefined>): number {
  return positiveIntEnv(env.PLANFORGE_BUILD_TIMEOUT_MS, DEFAULT_BUILD_TIMEOUT_MS);
}

export type CodexRunner = (request: CodexRunRequest) => Promise<CodexRunResult>;

export type RunCodexBuilderInput = {
  readonly handoff: CodexHandoff;
  readonly targetRepo: string;
  readonly runtimeRoot: string;
  readonly effort?: BuilderEffort;
  readonly model?: string;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly runner?: CodexRunner;
  readonly git?: GitRunner;
  readonly onChunk?: (chunk: string) => void;
  readonly timeoutMs?: number;
  readonly silenceMs?: number;
  readonly writeScopePolicy?: WriteScopePolicy;
  readonly signal?: AbortSignal;
  // Seam between worktree creation and the codex spawn: run-builder primes the fresh checkout here
  // (node_modules reuse) so the builder does not burn its wall budget on a cold npm ci. A rejection
  // lands in the catch below the runner, which tears the worktree down and rethrows.
  readonly onWorktreeReady?: (worktreePath: string) => Promise<void>;
};

export type CodexBuilderResult = {
  readonly branch: string;
  readonly worktreePath: string;
  readonly resultFile: string;
  readonly eventsFile: string;
  readonly statusPath: string;
  readonly exitCode: number | null;
  readonly lastMessage: string;
  readonly timedOut?: BuildTimeout;
  readonly aborted?: boolean;
  readonly cleanupFailed?: boolean;
  readonly scopeViolations: readonly WriteScopeViolation[];
};

export type RemoveCodexWorktreeInput = {
  readonly targetRepo: string;
  readonly worktreePath: string;
  readonly git: GitRunner;
};

const PLANFORGE_BUILDER_EMAIL = "planforge-builder@local";
const PLANFORGE_BUILDER_NAME = "PlanForge Builder";

export function buildCodexArgv(input: {
  readonly worktreePath: string;
  readonly resultFile: string;
  readonly effort?: BuilderEffort;
  readonly model?: string;
}): string[] {
  const argv = [
    "exec",
    "-c",
    'approval_policy="never"'
  ];
  if (input.effort) {
    argv.push("-c", `model_reasoning_effort="${input.effort}"`);
  }
  if (input.model && input.model !== "default") {
    argv.push("-m", input.model);
  }
  argv.push(
    "--cd",
    input.worktreePath,
    "--sandbox",
    "workspace-write",
    "--json",
    "-o",
    input.resultFile,
    "-"
  );
  return argv;
}

function assertSubscriptionMode(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  if (env.CODEX_API_KEY || env.OPENAI_API_KEY) {
    throw new PlanForgeError(
      "E_API_KEY_MODE",
      "Unset OPENAI_API_KEY/CODEX_API_KEY and use subscription login before starting codex execution."
    );
  }
}

async function writePrivateFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function gitTry(git: GitRunner, args: readonly string[]): Promise<void> {
  try {
    await git(args);
  } catch {
    return;
  }
}

// Like gitTry, but reports whether the command succeeded so post-timeout cleanup can surface a
// leaked checkout instead of silently swallowing the failure.
async function gitTryOk(git: GitRunner, args: readonly string[]): Promise<boolean> {
  try {
    await git(args);
    return true;
  } catch {
    return false;
  }
}

// Best-effort, non-throwing worktree teardown shared by every failure exit (timeout, non-zero
// exit, and the runner/post-build error path). Returns false if the checkout could not be removed
// so the caller can surface cleanupFailed instead of leaking or rejecting on a flaky removal.
async function removeWorktreeBestEffort(git: GitRunner, targetRepo: string, worktreePath: string): Promise<boolean> {
  const removed = await gitTryOk(git, ["-C", targetRepo, "worktree", "remove", "--force", worktreePath]);
  const pruned = await gitTryOk(git, ["-C", targetRepo, "worktree", "prune"]);
  return removed && pruned;
}

async function defaultRunner(request: CodexRunRequest): Promise<CodexRunResult> {
  await writePrivateFile(request.eventsFile, "");
  const events = createWriteStream(request.eventsFile, { flags: "a", mode: 0o600 });
  // detached: own a process group so the whole codex subtree is killable as -pid.
  const child = spawn("codex", request.argv, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: true
  });

  const timeoutMs = request.timeoutMs ?? 0;
  const silenceMs = request.silenceMs ?? 0;
  let timedOut: BuildTimeout | undefined;
  let aborted = false;
  let settled = false;
  let killSignal: NodeJS.Signals | null = null;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, signal);
      }
    } catch {
      // group already exited
    }
  };
  const killGroup = (reason: BuildTimeout) => {
    // Already terminating (a timer raced an abort, or vice versa): don't fire a second teardown or
    // misreport an aborted build as a timeout.
    if (timedOut || aborted) {
      return;
    }
    timedOut = reason;
    killSignal = "SIGTERM";
    signalGroup("SIGTERM");
    sigkillTimer = setTimeout(() => {
      killSignal = "SIGKILL";
      signalGroup("SIGKILL");
    }, SIGKILL_GRACE_MS);
    sigkillTimer.unref?.();
  };
  const abort = () => {
    // Operator stop / conversation teardown. Kill the build group like a timeout, but report
    // `aborted` (not a timeout) so the cycle is surfaced as canceled. No-op once otherwise settled.
    if (timedOut || aborted || settled) {
      return;
    }
    aborted = true;
    killSignal = "SIGTERM";
    signalGroup("SIGTERM");
    sigkillTimer = setTimeout(() => {
      killSignal = "SIGKILL";
      signalGroup("SIGKILL");
    }, SIGKILL_GRACE_MS);
    sigkillTimer.unref?.();
  };
  const armSilence = () => {
    if (silenceMs <= 0) {
      return;
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer);
    }
    silenceTimer = setTimeout(() => killGroup("silence"), silenceMs);
    silenceTimer.unref?.();
  };
  const clearTimers = () => {
    if (wallTimer) clearTimeout(wallTimer);
    if (silenceTimer) clearTimeout(silenceTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  };

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const fail = (error: Error) => {
      // Once the child has closed (resolve path), the build is settled; a final events/stream flush
      // 'error' must not re-enter fail() and fire a second SIGTERM/SIGKILL teardown.
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      // An events/stdout/stderr/spawn error abandons this build, but the detached codex group is
      // still alive and the events stream still holds an fd. Tear both down before rejecting.
      // Do NOT route through killGroup(): it sets timedOut and would misreport this as a timeout.
      signalGroup("SIGTERM");
      sigkillTimer = setTimeout(() => signalGroup("SIGKILL"), SIGKILL_GRACE_MS);
      sigkillTimer.unref?.();
      events.destroy();
      reject(error);
    };
    events.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stdin.on("error", () => {});
    child.once("error", fail);
    child.once("close", (code) => {
      settled = true;
      clearTimers();
      resolve(code);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      armSilence();
      request.onChunk(chunk.toString("utf8"));
    });
    child.stderr.on("data", () => armSilence());
    child.stdout.pipe(events, { end: false });
    child.stderr.pipe(events, { end: false });
    if (timeoutMs > 0) {
      wallTimer = setTimeout(() => killGroup("wall"), timeoutMs);
      wallTimer.unref?.();
    }
    if (request.signal) {
      if (request.signal.aborted) {
        abort();
      } else {
        request.signal.addEventListener("abort", abort, { once: true });
      }
    }
    armSilence();
    child.stdin.end(request.stdin);
  });

  await new Promise<void>((resolve, reject) => {
    events.once("error", reject);
    events.end(() => resolve());
  });
  await chmod(request.eventsFile, 0o600);
  return { exitCode, timedOut, aborted, signal: timedOut || aborted ? killSignal : undefined };
}

export async function runCodexBuilder(input: RunCodexBuilderInput): Promise<CodexBuilderResult> {
  const env = input.env ?? process.env;
  assertSubscriptionMode(env);
  const git = input.git ?? defaultGit;
  const runner = input.runner ?? defaultRunner;

  const runId = input.handoff.runId;
  const branch = `planforge/${runId}`;
  const worktreePath = path.join(input.runtimeRoot, "worktrees", runId);
  const runDir = path.join(input.runtimeRoot, "runs", runId);
  const resultFile = path.join(runDir, "last-message.txt");
  const eventsFile = path.join(runDir, "events.jsonl");
  const statusPath = path.join(worktreePath, "STATUS.md");
  const renderedHandoff = renderHandoffArtifact(input.handoff);

  await mkdir(runDir, { recursive: true });
  await writePrivateFile(resultFile, "");
  await writePrivateFile(eventsFile, "");
  await gitTry(git, ["-C", input.targetRepo, "worktree", "remove", "--force", worktreePath]);
  await gitTry(git, ["-C", input.targetRepo, "worktree", "prune"]);
  await gitTry(git, ["-C", input.targetRepo, "branch", "-D", branch]);
  // First git write against the untrusted target fires its post-checkout hook; neutralize hooks here
  // the same way the later commit and merge do, so a malicious target repo cannot run code on add.
  await git(["-C", input.targetRepo, "-c", "core.hooksPath=/dev/null", "worktree", "add", worktreePath, "-b", branch, "HEAD"]);

  const timeoutMs = input.timeoutMs ?? resolveBuildWallMs(env);
  const silenceMs = input.silenceMs ?? positiveIntEnv(env.PLANFORGE_BUILD_SILENCE_MS, DEFAULT_BUILD_SILENCE_MS);
  const argv = buildCodexArgv({ worktreePath, resultFile, effort: input.effort, model: input.model });

  try {
    if (input.onWorktreeReady) {
      await input.onWorktreeReady(worktreePath);
    }
    const result = await runner({
      argv,
      cwd: worktreePath,
      stdin: renderedHandoff,
      env: copyEnv(env),
      resultFile,
      eventsFile,
      onChunk: input.onChunk ?? (() => {}),
      timeoutMs,
      silenceMs,
      ...(input.signal ? { signal: input.signal } : {})
    });

    if (result.aborted) {
      // Operator stop / teardown force-killed the build mid-flight; its worktree is a half-finished
      // checkout. Drop it and report `aborted` so the cycle is canceled without testing or merging.
      const cleaned = await removeWorktreeBestEffort(git, input.targetRepo, worktreePath);
      return {
        branch,
        worktreePath,
        resultFile,
        eventsFile,
        statusPath,
        exitCode: result.exitCode,
        lastMessage: await readOptional(resultFile),
        aborted: true,
        ...(cleaned ? {} : { cleanupFailed: true }),
        scopeViolations: []
      };
    }

    if (result.timedOut) {
      // The build was force-killed; its worktree is a half-finished checkout. Drop it
      // and report the timeout so the cycle fails without testing or merging garbage.
      const cleaned = await removeWorktreeBestEffort(git, input.targetRepo, worktreePath);
      return {
        branch,
        worktreePath,
        resultFile,
        eventsFile,
        statusPath,
        exitCode: result.exitCode,
        lastMessage: await readOptional(resultFile),
        timedOut: result.timedOut,
        ...(cleaned ? {} : { cleanupFailed: true }),
        scopeViolations: []
      };
    }

    await git(["-C", worktreePath, "add", "-A"]);

    if (result.exitCode !== 0) {
      // A non-zero, non-timeout exit is a hard build failure: do not test or merge a failed build,
      // and tear down the leaked worktree here (non-throwing) so a flaky removal can't reject past
      // the caller's fail verifier_result emit.
      const cleaned = await removeWorktreeBestEffort(git, input.targetRepo, worktreePath);
      return {
        branch,
        worktreePath,
        resultFile,
        eventsFile,
        statusPath,
        exitCode: result.exitCode,
        lastMessage: await readOptional(resultFile),
        ...(cleaned ? {} : { cleanupFailed: true }),
        scopeViolations: []
      };
    }

    const writeScopePolicy = input.writeScopePolicy ?? defaultWriteScopePolicy();
    let scopeViolations: readonly WriteScopeViolation[] = [];
    const status = await git(["-C", worktreePath, "status", "--porcelain", "-z"]);
    if (status.stdout.trim().length > 0) {
      // Gate the commit: a build that touched protected/out-of-scope paths is never
      // committed, so run-builder fails the cycle before any verify or merge.
      scopeViolations = evaluateWriteScope(parsePorcelainPaths(status.stdout), writeScopePolicy);
      if (scopeViolations.length === 0) {
        await git([
          "-C",
          worktreePath,
          // Disable any target-repo commit hooks so a malicious or broken hook can't execute
          // arbitrary code during the builder commit.
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          `user.email=${PLANFORGE_BUILDER_EMAIL}`,
          "-c",
          `user.name=${PLANFORGE_BUILDER_NAME}`,
          "commit",
          "-m",
          `planforge build ${runId}`
        ]);
      }
    }

    return {
      branch,
      worktreePath,
      resultFile,
      eventsFile,
      statusPath,
      exitCode: result.exitCode,
      lastMessage: await readOptional(resultFile),
      scopeViolations
    };
  } catch (error) {
    // The runner or the post-build add/status/commit threw. Best-effort tear down the worktree so
    // it is not leaked, then re-throw the ORIGINAL error (never a cleanup error) so the caller sees
    // the real failure.
    await removeWorktreeBestEffort(git, input.targetRepo, worktreePath);
    throw error;
  }
}

export async function removeCodexWorktree(input: RemoveCodexWorktreeInput): Promise<void> {
  await input.git(["-C", input.targetRepo, "worktree", "remove", "--force", input.worktreePath]);
  await input.git(["-C", input.targetRepo, "worktree", "prune"]);
}

const defaultGit = createDefaultGitRunner();
