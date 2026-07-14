import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexHandoff } from "../src/domain";
import {
  buildCodexArgv,
  positiveIntEnv,
  removeCodexWorktree,
  resolveBuildWallMs,
  runCodexBuilder,
  type CodexRunner,
  type GitRunner
} from "../src/builder/codex-driver";

const handoff: CodexHandoff = {
  runId: "run-1",
  project: "fixture",
  objective: "Fix the failing test",
  context: "Temporary fixture repo",
  constraints: "Use the job worktree only",
  verification: ["npm test"],
  stop_conditions: ["Write STATUS.md and stop"]
};

function cleanGitRecorder(calls: string[]): GitRunner {
  return async (args) => {
    calls.push(args.join(" "));
    return { stdout: "", stderr: "" };
  };
}

describe("Codex builder driver", () => {
  it("codex argv", async () => {
    const captured: Array<{ argv: readonly string[]; stdin: string }> = [];
    const runner: CodexRunner = async (request) => {
      captured.push({ argv: request.argv, stdin: request.stdin });
      return { exitCode: 0 };
    };
    const git: GitRunner = async () => ({ stdout: "", stderr: "" });
    const runtimeRoot = "/tmp/planforge-runtime";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const resultFile = path.join(runtimeRoot, "runs", handoff.runId, "last-message.txt");

    await runCodexBuilder({
      handoff,
      targetRepo: "/tmp/fixture",
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner,
      git
    });

    expect(buildCodexArgv({ worktreePath, resultFile })).toEqual([
      "exec",
      "-c",
      'approval_policy="never"',
      "--cd",
      worktreePath,
      "--sandbox",
      "workspace-write",
      "--json",
      "-o",
      resultFile,
      "-"
    ]);
    expect(buildCodexArgv({ worktreePath, resultFile })).not.toContain('model_reasoning_effort="xhigh"');
    expect(captured[0]?.argv).toEqual(buildCodexArgv({ worktreePath, resultFile }));
    expect(captured[0]?.stdin).toContain("## Objective\nFix the failing test");
  });

  it("codex argv includes optional effort alongside approval and sandbox flags", () => {
    const runtimeRoot = "/tmp/planforge-runtime";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const resultFile = path.join(runtimeRoot, "runs", handoff.runId, "last-message.txt");

    expect(buildCodexArgv({ worktreePath, resultFile, effort: "xhigh" })).toEqual([
      "exec",
      "-c",
      'approval_policy="never"',
      "-c",
      'model_reasoning_effort="xhigh"',
      "--cd",
      worktreePath,
      "--sandbox",
      "workspace-write",
      "--json",
      "-o",
      resultFile,
      "-"
    ]);
  });

  it("codex argv includes the verified -m model flag only for a non-default model", () => {
    const runtimeRoot = "/tmp/planforge-runtime";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const resultFile = path.join(runtimeRoot, "runs", handoff.runId, "last-message.txt");

    expect(buildCodexArgv({ worktreePath, resultFile, model: "gpt-5.2-codex" })).toEqual([
      "exec",
      "-c",
      'approval_policy="never"',
      "-m",
      "gpt-5.2-codex",
      "--cd",
      worktreePath,
      "--sandbox",
      "workspace-write",
      "--json",
      "-o",
      resultFile,
      "-"
    ]);
    expect(buildCodexArgv({ worktreePath, resultFile, model: "default" })).toEqual(
      buildCodexArgv({ worktreePath, resultFile })
    );
  });

  it("api-key guard", async () => {
    const runner = vi.fn<CodexRunner>();

    await expect(
      runCodexBuilder({
        handoff,
        targetRepo: "/tmp/fixture",
        runtimeRoot: "/tmp/planforge-runtime",
        env: { CODEX_API_KEY: "metered" },
        runner,
        git: async () => ({ stdout: "", stderr: "" })
      })
    ).rejects.toMatchObject({ code: "E_API_KEY_MODE" });

    expect(runner).not.toHaveBeenCalled();
  });

  it("api-key guard (openai)", async () => {
    const runner = vi.fn<CodexRunner>();

    await expect(
      runCodexBuilder({
        handoff,
        targetRepo: "/tmp/fixture",
        runtimeRoot: "/tmp/planforge-runtime",
        env: { OPENAI_API_KEY: "metered" },
        runner,
        git: async () => ({ stdout: "", stderr: "" })
      })
    ).rejects.toMatchObject({ code: "E_API_KEY_MODE" });

    expect(runner).not.toHaveBeenCalled();
  });

  it("guards the worktree-add (the first write against the untrusted target) with core.hooksPath=/dev/null", async () => {
    const argvs: string[][] = [];
    const runtimeRoot = "/tmp/planforge-runtime-hooks-guard";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const git: GitRunner = async (args) => {
      argvs.push([...args]);
      return { stdout: "", stderr: "" };
    };

    await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => ({ exitCode: 0 }),
      git
    });

    const worktreeAdd = argvs.find((argv) => argv.includes("worktree") && argv.includes("add"));
    expect(worktreeAdd).toEqual([
      "-C",
      targetRepo,
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      worktreePath,
      "-b",
      `planforge/${handoff.runId}`,
      "HEAD"
    ]);
  });

  it("worktree lifecycle", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const git = cleanGitRecorder(calls);
    const runner: CodexRunner = async () => {
      expect(calls[3]).toBe(`-C ${targetRepo} -c core.hooksPath=/dev/null worktree add ${worktreePath} -b planforge/${handoff.runId} HEAD`);
      calls.push("codex runner");
      return { exitCode: 0 };
    };

    const result = await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner,
      git
    });
    await removeCodexWorktree({ targetRepo, worktreePath: result.worktreePath, git });

    expect(result.branch).toBe(`planforge/${handoff.runId}`);
    expect(calls).toEqual([
      `-C ${targetRepo} worktree remove --force ${worktreePath}`,
      `-C ${targetRepo} worktree prune`,
      `-C ${targetRepo} branch -D planforge/${handoff.runId}`,
      `-C ${targetRepo} -c core.hooksPath=/dev/null worktree add ${worktreePath} -b planforge/${handoff.runId} HEAD`,
      "codex runner",
      `-C ${worktreePath} add -A`,
      `-C ${worktreePath} status --porcelain -z`,
      `-C ${targetRepo} worktree remove --force ${worktreePath}`,
      `-C ${targetRepo} worktree prune`
    ]);
  });

  it("commits when Codex changed the worktree", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-changed";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const git: GitRunner = async (args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === `-C ${worktreePath} status --porcelain -z`) {
        return { stdout: " M actual.txt\0", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => ({ exitCode: 0 }),
      git
    });

    expect(calls).toContain(`-C ${worktreePath} add -A`);
    expect(calls).toContain(`-C ${worktreePath} status --porcelain -z`);
    expect(calls).toContain(
      `-C ${worktreePath} -c core.hooksPath=/dev/null -c user.email=planforge-builder@local -c user.name=PlanForge Builder commit -m planforge build ${handoff.runId}`
    );
    expect(calls.indexOf(`-C ${worktreePath} add -A`)).toBeLessThan(
      calls.indexOf(
        `-C ${worktreePath} -c core.hooksPath=/dev/null -c user.email=planforge-builder@local -c user.name=PlanForge Builder commit -m planforge build ${handoff.runId}`
      )
    );
  });

  it("skips the builder commit when the worktree is clean", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-clean";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);

    await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => ({ exitCode: 0 }),
      git: cleanGitRecorder(calls)
    });

    expect(calls).toContain(`-C ${worktreePath} add -A`);
    expect(calls).toContain(`-C ${worktreePath} status --porcelain -z`);
    expect(calls.some((call) => call.includes(" commit -m "))).toBe(false);
  });

  it("skips the builder commit when Codex exits non-zero", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-failed";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const git: GitRunner = async (args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === `-C ${worktreePath} status --porcelain -z`) {
        return { stdout: " M actual.txt\0", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => ({ exitCode: 1 }),
      git
    });

    expect(calls).toContain(`-C ${worktreePath} add -A`);
    expect(calls.some((call) => call.includes(" commit -m "))).toBe(false);
  });

  it("retries over leftover worktree and branch state", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-retry";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    let worktreeExists = false;
    let branchExists = false;
    const git: GitRunner = async (args) => {
      calls.push(args.join(" "));
      const command = args.join(" ");
      if (command === `-C ${targetRepo} worktree remove --force ${worktreePath}`) {
        if (!worktreeExists) {
          throw new Error("worktree missing");
        }
        worktreeExists = false;
        return { stdout: "", stderr: "" };
      }
      if (command === `-C ${targetRepo} worktree prune`) {
        return { stdout: "", stderr: "" };
      }
      if (command === `-C ${targetRepo} branch -D planforge/${handoff.runId}`) {
        if (!branchExists) {
          throw new Error("branch missing");
        }
        branchExists = false;
        return { stdout: "", stderr: "" };
      }
      if (command === `-C ${targetRepo} -c core.hooksPath=/dev/null worktree add ${worktreePath} -b planforge/${handoff.runId} HEAD`) {
        if (worktreeExists || branchExists) {
          throw new Error("leftover state");
        }
        worktreeExists = true;
        branchExists = true;
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => ({ exitCode: 0 }),
      git
    });
    await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => ({ exitCode: 0 }),
      git
    });

    expect(calls.filter((call) => call === `-C ${targetRepo} -c core.hooksPath=/dev/null worktree add ${worktreePath} -b planforge/${handoff.runId} HEAD`)).toHaveLength(2);
  });

  it("parses build-timeout env values and rejects invalid ones", () => {
    expect(positiveIntEnv("1000", 50)).toBe(1000);
    expect(positiveIntEnv(undefined, 50)).toBe(50);
    expect(positiveIntEnv("   ", 50)).toBe(50);
    expect(positiveIntEnv("0", 50)).toBe(0);
    for (const bad of ["abc", "-5", "1.5"]) {
      expect(() => positiveIntEnv(bad, 50)).toThrow(expect.objectContaining({ code: "E_INVALID_BUILD_TIMEOUT" }));
    }
  });

  it("passes the resolved build timeouts to the runner", async () => {
    let seen: { timeoutMs?: number; silenceMs?: number } | undefined;
    const runner: CodexRunner = async (request) => {
      seen = { timeoutMs: request.timeoutMs, silenceMs: request.silenceMs };
      return { exitCode: 0 };
    };
    await runCodexBuilder({
      handoff,
      targetRepo: "/tmp/fixture",
      runtimeRoot: "/tmp/planforge-runtime",
      env: { PATH: "/usr/bin", PLANFORGE_BUILD_TIMEOUT_MS: "1234", PLANFORGE_BUILD_SILENCE_MS: "567" },
      runner,
      git: async () => ({ stdout: "", stderr: "" })
    });
    expect(seen).toEqual({ timeoutMs: 1234, silenceMs: 567 });
  });

  it("defaults the build wall to 30 minutes when no override is set", async () => {
    let seen: { timeoutMs?: number; silenceMs?: number } | undefined;
    const runner: CodexRunner = async (request) => {
      seen = { timeoutMs: request.timeoutMs, silenceMs: request.silenceMs };
      return { exitCode: 0 };
    };
    await runCodexBuilder({
      handoff,
      targetRepo: "/tmp/fixture",
      runtimeRoot: "/tmp/planforge-runtime",
      env: { PATH: "/usr/bin" },
      runner,
      git: async () => ({ stdout: "", stderr: "" })
    });
    expect(seen).toEqual({ timeoutMs: 1_800_000, silenceMs: 300_000 });
    // The exported resolver reports the same wall runCodexBuilder applies (default + env override).
    expect(resolveBuildWallMs({ PATH: "/usr/bin" })).toBe(1_800_000);
    expect(resolveBuildWallMs({ PLANFORGE_BUILD_TIMEOUT_MS: "1234" })).toBe(1234);
  });

  it("on timeout: removes the worktree, skips add/commit, and propagates timedOut", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-timeout";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const result = await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      timeoutMs: 5,
      runner: async () => ({ exitCode: null, timedOut: "wall", signal: "SIGTERM" }),
      git: cleanGitRecorder(calls)
    });
    expect(result.timedOut).toBe("wall");
    expect(calls.some((c) => c === `-C ${worktreePath} add -A`)).toBe(false);
    expect(calls.some((c) => c.includes(" commit -m "))).toBe(false);
    // cleanup removes the dead worktree after the runner returns
    const adds = calls.filter((c) => c === `-C ${targetRepo} -c core.hooksPath=/dev/null worktree add ${worktreePath} -b planforge/${handoff.runId} HEAD`);
    const removesAfter = calls
      .slice(calls.indexOf(adds[0]!) + 1)
      .filter((c) => c === `-C ${targetRepo} worktree remove --force ${worktreePath}`);
    expect(removesAfter.length).toBeGreaterThanOrEqual(1);
  });

  it("on abort: removes the worktree, skips add/commit, and propagates aborted (not timedOut)", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-abort";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const result = await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => ({ exitCode: null, aborted: true, signal: "SIGTERM" }),
      git: cleanGitRecorder(calls)
    });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBeUndefined();
    expect(calls.some((c) => c === `-C ${worktreePath} add -A`)).toBe(false);
    expect(calls.some((c) => c.includes(" commit -m "))).toBe(false);
    const add = `-C ${targetRepo} -c core.hooksPath=/dev/null worktree add ${worktreePath} -b planforge/${handoff.runId} HEAD`;
    const removesAfter = calls
      .slice(calls.indexOf(add) + 1)
      .filter((c) => c === `-C ${targetRepo} worktree remove --force ${worktreePath}`);
    expect(removesAfter.length).toBeGreaterThanOrEqual(1);
  });

  it("threads the abort signal through to the runner", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    await runCodexBuilder({
      handoff,
      targetRepo: "/tmp/fixture",
      runtimeRoot: "/tmp/planforge-runtime-signal",
      env: { PATH: "/usr/bin" },
      signal: controller.signal,
      runner: async (request) => {
        seenSignal = request.signal;
        return { exitCode: 0 };
      },
      git: cleanGitRecorder([])
    });
    expect(seenSignal).toBe(controller.signal);
  });

  it("flags cleanupFailed when post-timeout worktree removal fails instead of silently leaking", async () => {
    const runtimeRoot = "/tmp/planforge-runtime-timeout-leak";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    let postBuild = false;
    const git: GitRunner = async (args) => {
      const command = args.join(" ");
      // Let the pre-build remove/prune/branch/add succeed; only the post-timeout removal fails.
      if (command === `-C ${targetRepo} worktree remove --force ${worktreePath}` && postBuild) {
        throw new Error("worktree busy");
      }
      return { stdout: "", stderr: "" };
    };
    const result = await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      timeoutMs: 5,
      runner: async () => {
        postBuild = true;
        return { exitCode: null, timedOut: "wall", signal: "SIGTERM" };
      },
      git
    });
    expect(result.timedOut).toBe("wall");
    expect(result.cleanupFailed).toBe(true);
  });

  it("leaves cleanupFailed unset when post-timeout worktree removal succeeds", async () => {
    const runtimeRoot = "/tmp/planforge-runtime-timeout-clean";
    const result = await runCodexBuilder({
      handoff,
      targetRepo: "/tmp/fixture",
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      timeoutMs: 5,
      runner: async () => ({ exitCode: null, timedOut: "wall", signal: "SIGTERM" }),
      git: async () => ({ stdout: "", stderr: "" })
    });
    expect(result.timedOut).toBe("wall");
    expect(result.cleanupFailed).toBeUndefined();
  });

  it("blocks the commit and reports scopeViolations when Codex touches a protected path", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-scope";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const git: GitRunner = async (args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === `-C ${worktreePath} status --porcelain -z`) {
        return { stdout: " M projects/products/planforge/docs/x/ACCEPTANCE.md\0", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const result = await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => ({ exitCode: 0 }),
      git
    });
    expect(result.scopeViolations).toEqual([
      { path: "projects/products/planforge/docs/x/ACCEPTANCE.md", reason: "protected" }
    ]);
    expect(calls.some((c) => c.includes(" commit -m "))).toBe(false);
  });

  it("blocks the commit for a C-quotable spaced protected path that -z leaves unquoted", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-scope-spaced";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const git: GitRunner = async (args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === `-C ${worktreePath} status --porcelain -z`) {
        return { stdout: " M projects/products/planforge/docs/a b/ACCEPTANCE.md\0", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const result = await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => ({ exitCode: 0 }),
      git
    });
    expect(result.scopeViolations).toEqual([
      { path: "projects/products/planforge/docs/a b/ACCEPTANCE.md", reason: "protected" }
    ]);
    expect(calls.some((c) => c.includes(" commit -m "))).toBe(false);
  });

  it("commits and reports no scopeViolations for an in-scope source change", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-scope-ok";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const git: GitRunner = async (args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === `-C ${worktreePath} status --porcelain -z`) {
        return { stdout: " M projects/products/planforge/src/App.tsx\0", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const result = await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => ({ exitCode: 0 }),
      git
    });
    expect(result.scopeViolations).toEqual([]);
    expect(calls.some((c) => c.includes(" commit -m "))).toBe(true);
  });

  it("on a runner rejection: force-removes the worktree and propagates the ORIGINAL error", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-runner-throw";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const git = cleanGitRecorder(calls);
    const originalError = new Error("runner blew up mid-build");

    await expect(
      runCodexBuilder({
        handoff,
        targetRepo,
        runtimeRoot,
        env: { PATH: "/usr/bin" },
        runner: async () => {
          throw originalError;
        },
        git
      })
    ).rejects.toBe(originalError);

    // The leaked worktree is torn down after the rejection, before the original error re-throws.
    const removesAfterAdd = calls
      .slice(calls.indexOf(`-C ${targetRepo} -c core.hooksPath=/dev/null worktree add ${worktreePath} -b planforge/${handoff.runId} HEAD`) + 1)
      .filter((call) => call === `-C ${targetRepo} worktree remove --force ${worktreePath}`);
    expect(removesAfterAdd.length).toBeGreaterThanOrEqual(1);
  });

  it("on a runner rejection: re-throws the ORIGINAL error even when worktree removal also fails", async () => {
    const runtimeRoot = "/tmp/planforge-runtime-runner-throw-cleanup-throw";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const originalError = new Error("runner blew up mid-build");
    let postBuild = false;
    const git: GitRunner = async (args) => {
      const command = args.join(" ");
      if (command === `-C ${targetRepo} worktree remove --force ${worktreePath}` && postBuild) {
        throw new Error("cleanup also failed");
      }
      return { stdout: "", stderr: "" };
    };

    await expect(
      runCodexBuilder({
        handoff,
        targetRepo,
        runtimeRoot,
        env: { PATH: "/usr/bin" },
        runner: async () => {
          postBuild = true;
          throw originalError;
        },
        git
      })
    ).rejects.toBe(originalError);
  });

  it("on a non-zero exit: removes the worktree, skips the commit, and reports no scopeViolations", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-nonzero-cleanup";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const result = await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => ({ exitCode: 17 }),
      git: cleanGitRecorder(calls)
    });

    expect(result.exitCode).toBe(17);
    expect(result.timedOut).toBeUndefined();
    expect(result.cleanupFailed).toBeUndefined();
    expect(result.scopeViolations).toEqual([]);
    expect(calls.some((c) => c.includes(" commit -m "))).toBe(false);
    const removesAfterAdd = calls
      .slice(calls.indexOf(`-C ${worktreePath} add -A`) + 1)
      .filter((c) => c === `-C ${targetRepo} worktree remove --force ${worktreePath}`);
    expect(removesAfterAdd.length).toBeGreaterThanOrEqual(1);
  });

  it("on a non-zero exit: surfaces cleanupFailed (no reject) when worktree removal throws", async () => {
    const runtimeRoot = "/tmp/planforge-runtime-nonzero-leak";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    let postBuild = false;
    const git: GitRunner = async (args) => {
      const command = args.join(" ");
      // Pre-build remove/prune/branch/add succeed; only the post-failure removal throws.
      if (command === `-C ${targetRepo} worktree remove --force ${worktreePath}` && postBuild) {
        throw new Error("worktree busy");
      }
      return { stdout: "", stderr: "" };
    };
    const result = await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      runner: async () => {
        postBuild = true;
        return { exitCode: 17 };
      },
      git
    });

    // A flaky removal does not reject past the caller's fail emit; it surfaces cleanupFailed.
    expect(result.exitCode).toBe(17);
    expect(result.cleanupFailed).toBe(true);
  });

  it("invokes onWorktreeReady between worktree creation and the codex spawn", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-worktree-ready";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);

    await runCodexBuilder({
      handoff,
      targetRepo,
      runtimeRoot,
      env: { PATH: "/usr/bin" },
      onWorktreeReady: async (readyPath) => {
        expect(readyPath).toBe(worktreePath);
        calls.push("worktree ready");
      },
      runner: async () => {
        calls.push("codex runner");
        return { exitCode: 0 };
      },
      git: cleanGitRecorder(calls)
    });

    const addIndex = calls.indexOf(
      `-C ${targetRepo} -c core.hooksPath=/dev/null worktree add ${worktreePath} -b planforge/${handoff.runId} HEAD`
    );
    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("worktree ready")).toBeGreaterThan(addIndex);
    expect(calls.indexOf("worktree ready")).toBeLessThan(calls.indexOf("codex runner"));
  });

  it("on an onWorktreeReady rejection: skips the spawn, tears down the worktree, and propagates the error", async () => {
    const calls: string[] = [];
    const runtimeRoot = "/tmp/planforge-runtime-worktree-ready-throw";
    const targetRepo = "/tmp/fixture";
    const worktreePath = path.join(runtimeRoot, "worktrees", handoff.runId);
    const originalError = new Error("worktree priming blew up");
    const runner = vi.fn<CodexRunner>();

    await expect(
      runCodexBuilder({
        handoff,
        targetRepo,
        runtimeRoot,
        env: { PATH: "/usr/bin" },
        onWorktreeReady: async () => {
          throw originalError;
        },
        runner,
        git: cleanGitRecorder(calls)
      })
    ).rejects.toBe(originalError);

    expect(runner).not.toHaveBeenCalled();
    const removesAfterAdd = calls
      .slice(calls.indexOf(`-C ${targetRepo} -c core.hooksPath=/dev/null worktree add ${worktreePath} -b planforge/${handoff.runId} HEAD`) + 1)
      .filter((call) => call === `-C ${targetRepo} worktree remove --force ${worktreePath}`);
    expect(removesAfterAdd.length).toBeGreaterThanOrEqual(1);
  });

  it("codex runner forwards raw stdout chunk payloads", async () => {
    const chunks: string[] = [];
    const runner: CodexRunner = async (request) => {
      request.onChunk("known codex chunk\n");
      return { exitCode: 0 };
    };

    await runCodexBuilder({
      handoff,
      targetRepo: "/tmp/fixture",
      runtimeRoot: "/tmp/planforge-runtime",
      env: { PATH: "/usr/bin" },
      runner,
      git: async () => ({ stdout: "", stderr: "" }),
      onChunk: (chunk) => chunks.push(chunk)
    });

    expect(chunks).toEqual(["known codex chunk\n"]);
  });
});
