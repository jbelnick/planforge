import { spawn } from "node:child_process";
import type { VerifierResult, VerifierStatus } from "./domain";

const SIGKILL_GRACE_MS = 5_000;

// Captured verifier output is bounded to head + tail totalling 64KiB per stream: the raw blob lands
// verbatim as one verify_result transcript entry, so an unbounded capture (a chatty test runner, a
// looping watcher) would both hold the whole blob in memory and bloat the transcript forever.
const CAPTURE_HEAD_LIMIT = 32 * 1024;
const CAPTURE_TAIL_LIMIT = 32 * 1024;

type BoundedCapture = {
  readonly push: (chunk: string) => void;
  readonly render: () => string;
};

// Keeps the first CAPTURE_HEAD_LIMIT chars and a rolling window of the last CAPTURE_TAIL_LIMIT
// chars; everything between is dropped as it streams and replaced by one elision marker on render.
function createBoundedCapture(): BoundedCapture {
  let head = "";
  const tail: string[] = [];
  let tailLength = 0;
  let elided = 0;

  return {
    push(chunk) {
      let rest = chunk;
      if (head.length < CAPTURE_HEAD_LIMIT) {
        const take = CAPTURE_HEAD_LIMIT - head.length;
        head += rest.slice(0, take);
        rest = rest.slice(take);
      }
      if (rest.length === 0) {
        return;
      }
      tail.push(rest);
      tailLength += rest.length;
      while (tailLength > CAPTURE_TAIL_LIMIT) {
        const first = tail[0] as string;
        const excess = tailLength - CAPTURE_TAIL_LIMIT;
        if (first.length <= excess) {
          tail.shift();
          tailLength -= first.length;
          elided += first.length;
        } else {
          tail[0] = first.slice(excess);
          tailLength -= excess;
          elided += excess;
        }
      }
    },
    render() {
      const kept = tail.join("");
      if (elided === 0) {
        return head + kept;
      }
      return `${head}\n... [verifier output elided: ${elided} characters omitted] ...\n${kept}`;
    }
  };
}

export type VerifierCommand = {
  readonly name: string;
  readonly command: string;
};

export type VerifierCommandOutput = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type VerifierCommandRunner = (command: string, cwd: string) => Promise<VerifierCommandOutput>;

export type RunAcceptanceVerifiersInput = {
  readonly worktreePath: string;
  readonly commands: readonly VerifierCommand[];
  readonly runner?: VerifierCommandRunner;
  // Wall-clock budget per verifier command. 0 (the default) disables the timeout. A command that
  // exceeds it is group-killed and reported `blocked` (exitCode null) so a hung verifier — a watch
  // mode left running, an `npm ci` stalled on a cold network — releases the loop instead of wedging
  // it forever (the build wall only covers the Codex run, not this independent verify phase).
  readonly timeoutMs?: number;
};

function normalizeStatus(exitCode: number | null): VerifierStatus {
  if (exitCode === 0) {
    return "pass";
  }
  if (exitCode === null) {
    return "blocked";
  }
  return "fail";
}

export function aggregateStatus(results: readonly VerifierResult[]): VerifierStatus {
  if (results.length === 0 || results.some((result) => result.status === "blocked")) {
    return "blocked";
  }
  if (results.some((result) => result.status === "fail")) {
    return "fail";
  }
  return "pass";
}

function combineOutput(stdout: string, stderr: string): string {
  return [stdout.trimEnd(), stderr.trimEnd()].filter((part) => part.length > 0).join("\n");
}

export function createVerifierRunner(timeoutMs: number): VerifierCommandRunner {
  return (command, cwd) =>
    new Promise((resolve) => {
      // detached only when a timeout is armed: it makes the shell its own process-group leader so a
      // hung pipeline (npm → node → grandchildren) can be reaped as a group. With no timeout the
      // behaviour is identical to a plain foreground spawn.
      const armed = timeoutMs > 0;
      const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: armed });
      const stdout = createBoundedCapture();
      const stderr = createBoundedCapture();
      let settled = false;
      let timedOut = false;
      let wallTimer: ReturnType<typeof setTimeout> | undefined;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) {
          return;
        }
        try {
          process.kill(armed ? -child.pid : child.pid, signal);
        } catch {
          // The process group is already gone; nothing to signal.
        }
      };

      const finish = (exitCode: number | null, extraStderr: string) => {
        if (settled) {
          return;
        }
        settled = true;
        if (wallTimer) {
          clearTimeout(wallTimer);
        }
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
        }
        resolve({ exitCode, stdout: stdout.render(), stderr: `${stderr.render()}${extraStderr}` });
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => stdout.push(chunk));
      child.stderr.on("data", (chunk: string) => stderr.push(chunk));
      child.once("error", (error) => finish(null, error.message));
      child.once("close", (exitCode) =>
        // A timed-out command reports `blocked` (exitCode null), never the kill's exit code, so it is
        // never mistaken for a real verifier pass/fail.
        timedOut
          ? finish(null, `\nVerifier command exceeded the ${timeoutMs}ms wall and was killed.`)
          : finish(exitCode, "")
      );

      if (armed) {
        wallTimer = setTimeout(() => {
          timedOut = true;
          killGroup("SIGTERM");
          sigkillTimer = setTimeout(() => killGroup("SIGKILL"), SIGKILL_GRACE_MS);
          sigkillTimer.unref?.();
        }, timeoutMs);
        wallTimer.unref?.();
      }
    });
}

export async function runAcceptanceVerifiers(input: RunAcceptanceVerifiersInput): Promise<VerifierResult[]> {
  const runner = input.runner ?? createVerifierRunner(input.timeoutMs ?? 0);
  const results: VerifierResult[] = [];
  for (const verifier of input.commands) {
    const output = await runner(verifier.command, input.worktreePath);
    results.push({
      name: verifier.name,
      status: normalizeStatus(output.exitCode),
      exitCode: output.exitCode,
      output: combineOutput(output.stdout, output.stderr)
    });
  }
  return results;
}
