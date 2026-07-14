import path from "node:path";
import { PlanForgeError } from "./errors";
import type { HandoffResult } from "./domain";
import type { CodexRunner, GitRunner } from "./builder/codex-driver";
import { createDefaultGitRunner, resolveBuildWallMs, runCodexBuilder } from "./builder/codex-driver";
import { linkNodeModules } from "./builder/node-modules-link";
import { computeTestDelta } from "./builder/test-delta";
import type { TestDelta } from "./domain";
import type { ChatRunService } from "./run-service";
import type { RunBuilder } from "./registry";
import { assertAllowedTargetRepo } from "./target-allowlist";
import type { PlanForgeToolLoopConfig } from "./tools";
import type { BuilderEffort } from "./effort";
import type { VerifierCommandRunner } from "./verifier";
import { aggregateStatus, runAcceptanceVerifiers } from "./verifier";
import { readTargetVerifierSpec, VERIFIER_SPEC_FILENAME } from "./verifier-spec";

export type CreatePlanForgeRunBuilderInput = {
  readonly runService: ChatRunService;
  readonly loopConfig: PlanForgeToolLoopConfig;
  // Per-run target override (runId -> resolved targetRepo), populated by the orchestrator so a
  // conversation with its own target builds there instead of loopConfig.targetRepo.
  readonly targetRepoStore?: Map<string, string>;
  readonly runSettingsStore?: Map<string, BuilderRunSettings>;
  // Estate root for the target allowlist re-check at run start. Same value start-server validates the
  // boot/create target against; passed through so the standalone-repo assert can re-run here.
  readonly workspaceRoot?: string;
  // Run-start target re-validation. Defaults to assertAllowedTargetRepo (allowlist + standalone-repo
  // assert) bound to workspaceRoot; throws to fail the build. Injectable so event-flow tests that use
  // fixture targets can bypass it — production always uses the default.
  readonly validateTarget?: (targetRepo: string) => void;
  readonly codexRunner?: CodexRunner;
  readonly git?: GitRunner;
  readonly verifierRunner?: VerifierCommandRunner;
};

export type BuilderRunSettings = {
  readonly builderEffort?: BuilderEffort;
  readonly builderModel?: string;
};

// The target's HEAD sha — the base the build worktree forks from and the left side of the
// post-build test-delta diff. Returns null on any git failure so a delta-computation problem never
// fails an otherwise-good build.
async function resolveHead(git: GitRunner, targetRepo: string): Promise<string | null> {
  try {
    const result = await git(["-C", targetRepo, "rev-parse", "HEAD"]);
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

// Operator-facing wall label for the build stream and the wall-timeout verifier output. Whole
// minutes for real configurations, raw seconds otherwise; a zero wall means the wall is disabled.
function formatWall(ms: number): string {
  if (ms <= 0) {
    return "off";
  }
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
}

export function createPlanForgeRunBuilder(input: CreatePlanForgeRunBuilderInput): RunBuilder {
  const validateTarget =
    input.validateTarget ??
    ((targetRepo: string) =>
      assertAllowedTargetRepo({
        targetRepo,
        ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {})
      }));
  return async (handoff, options): Promise<HandoffResult> => {
    const run = input.runService.get(handoff.runId);
    if (!run) {
      throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${handoff.runId} was not found.`);
    }

    const runBuilderBody = async (): Promise<HandoffResult> => {
      let emittedCodexChunk = false;
      // Resolve this run's build target: the per-conversation override (set by the orchestrator) if
      // any, else the server-configured default.
      const targetRepo = input.targetRepoStore?.get(handoff.runId) ?? input.loopConfig.targetRepo;
      // Re-validate the target at run start, BEFORE any worktree is created. The allowlist +
      // standalone-repo assert runs at boot/create/updateTarget, but a conversation persisted before
      // that assert existed, or a target whose `.git` was since removed/altered (e.g. into a symlink or
      // an escaping gitfile), would otherwise reach the worktree/merge machinery here and act on the
      // enclosing repo. Fail the build closed with a clear error if the target no longer qualifies.
      try {
        validateTarget(targetRepo);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        input.runService.emit(run, "codex_stream", {
          runId: handoff.runId,
          chunk: `Build skipped: target repo failed re-validation at run start — ${reason}`
        });
        const targetVerifier = [{ name: "target-allowlist", status: "fail" as const, output: reason }];
        input.runService.emit(run, "verifier_result", {
          runId: handoff.runId,
          status: "fail",
          verifierResults: targetVerifier,
          summary: "Verifier status: fail (target repo re-validation)."
        });
        return { status: "fail", verifierResults: targetVerifier };
      }
      // Resolve this build's verifiers INDEPENDENTLY of the builder, at handoff time: the target's
      // checked-in `.planforge-verify.json` is read from the target repo's own checked-out tree,
      // never from the build worktree (the worktree is builder-writable — a spec read there would
      // let the builder swap in a vacuous verifier and grade itself). Snapshotting before the build
      // starts also means nothing the builder does this cycle can change how it is graded.
      // Precedence: target spec > env/default (loopConfig). An unusable spec fails the cycle up
      // front (fail-closed, never a silent fallback) and skips the build, whose verify could never
      // be trusted.
      const verifierSpec = await readTargetVerifierSpec(targetRepo);
      if (verifierSpec.source === "invalid") {
        input.runService.emit(run, "codex_stream", {
          runId: handoff.runId,
          chunk: `Build skipped: ${VERIFIER_SPEC_FILENAME} in the target repo is invalid — ${verifierSpec.reason}`
        });
        const specVerifier = [
          {
            name: "verifier-spec",
            status: "fail" as const,
            output: `invalid ${VERIFIER_SPEC_FILENAME}: ${verifierSpec.reason}`
          }
        ];
        input.runService.emit(run, "verifier_result", {
          runId: handoff.runId,
          status: "fail",
          verifierResults: specVerifier,
          summary: `Verifier status: fail (invalid ${VERIFIER_SPEC_FILENAME}).`
        });
        return { status: "fail", verifierResults: specVerifier };
      }
      const verifierCommands = verifierSpec.source === "spec" ? verifierSpec.commands : input.loopConfig.verifierCommands;
      const verifierTimeoutMs =
        verifierSpec.source === "spec" && verifierSpec.timeoutMs !== undefined
          ? verifierSpec.timeoutMs
          : input.loopConfig.verifierTimeoutMs;
      // The effective wall this build runs under — the same env resolution runCodexBuilder applies
      // (run-builder passes no explicit timeoutMs). Surfaced at build start and on a wall kill so the
      // operator knows which knob (PLANFORGE_BUILD_TIMEOUT_MS) to turn.
      const buildWallMs = resolveBuildWallMs(input.loopConfig.env);
      const runSettings = input.runSettingsStore?.get(handoff.runId);
      const builderEffort = runSettings?.builderEffort ?? input.loopConfig.builderEffort;
      const builderModel = runSettings?.builderModel ?? input.loopConfig.builderModel;
      // Capture the build wall-clock so the operator can see how long the builder side took (the
      // builder emits no parsed token usage, but its time + effort are real and worth surfacing).
      const buildStartedAt = Date.now();
      const gitRunner = input.git ?? createDefaultGitRunner();
      // The base commit the build worktree will fork from — runCodexBuilder creates it with
      // `git worktree add <path> -b <branch> HEAD`, so resolving HEAD here captures that base for the
      // post-build test-delta diff (base..branch). Best-effort: if HEAD can't be resolved (e.g. an
      // empty repo), the delta is skipped rather than failing the build.
      const buildBase = await resolveHead(gitRunner, targetRepo);
      const builderResult = await runCodexBuilder({
        handoff,
        targetRepo,
        runtimeRoot: input.loopConfig.runtimeRoot,
        effort: builderEffort,
        model: builderModel,
        env: input.loopConfig.env,
        ...(input.loopConfig.writeScopePolicy ? { writeScopePolicy: input.loopConfig.writeScopePolicy } : {}),
        runner: input.codexRunner,
        git: input.git,
        ...(options?.signal ? { signal: options.signal } : {}),
        // Reuse the target repo's installed node_modules in the BUILD worktree too: every codex
        // build starts in a fresh worktree, and a cold `npm ci` burns minutes of the builder's wall
        // budget before any real work. Best-effort — on fallback the build proceeds and the
        // target's `.planforge-verify.json` self-healing npm-ci guard still covers verify.
        // requireIgnored keeps the pre-commit symlink out of the post-build `git add -A`. Both
        // outcomes are emitted into the build stream (build_output transcript entries) so operators
        // can see why a build might be slow. Emitted directly (not via onChunk) so the
        // emittedCodexChunk fallback below still reflects codex's own output only.
        onWorktreeReady: async (worktreePath) => {
          input.runService.emit(run, "codex_stream", {
            runId: handoff.runId,
            chunk: `PlanForge: build started (wall ${formatWall(buildWallMs)}, worktree ${path.basename(worktreePath)}).\n`
          });
          const buildLink = await linkNodeModules({ targetRepo, worktreePath, git: gitRunner, requireIgnored: true });
          input.runService.emit(run, "codex_stream", {
            runId: handoff.runId,
            chunk: buildLink.linked
              ? `PlanForge: linked node_modules into the build worktree (${buildLink.dest}).\n`
              : `PlanForge: did not link node_modules into the build worktree (${buildLink.reason ?? "unknown"}); the build pays a fresh npm ci if it needs dependencies.\n`
          });
        },
        onChunk: (chunk) => {
          emittedCodexChunk = true;
          input.runService.emit(run, "codex_stream", { runId: handoff.runId, chunk });
        }
      });
      const buildDurationMs = Date.now() - buildStartedAt;
      // Surface the builder-side spend (build wall-clock + effort) as a run-bus event the orchestrator
      // turns into a builder `usage` transcript entry at cycle completion. Effort is the loop-config
      // default (the same value passed to runCodexBuilder above); the builder model is only known when
      // explicitly configured (Codex does not report one), so it is omitted rather than invented.
      input.runService.emit(run, "build_usage", {
        runId: handoff.runId,
        side: "builder",
        durationMs: buildDurationMs,
        ...(builderEffort ? { effort: builderEffort } : {}),
        ...(builderModel && builderModel !== "default" ? { model: builderModel } : {})
      });

      if (builderResult.aborted) {
        // Operator stop / teardown killed the build mid-flight. Surface a terminal blocked result so
        // the architect's handoff_to_codex returns at once (no waiting on the build wall) and the
        // stop completes responsively; nothing is verified or merged.
        input.runService.emit(run, "codex_stream", {
          runId: handoff.runId,
          chunk: "\nCodex build canceled (operator stop / teardown); killed the build process group."
        });
        if (builderResult.cleanupFailed) {
          input.runService.emit(run, "codex_stream", {
            runId: handoff.runId,
            chunk: `\nWARNING: failed to remove the canceled build worktree at ${builderResult.worktreePath}; it may be leaked and need manual cleanup.`
          });
        }
        const canceledVerifier = [{ name: "codex", status: "blocked" as const, output: "build canceled" }];
        input.runService.emit(run, "verifier_result", {
          runId: handoff.runId,
          status: "blocked",
          verifierResults: canceledVerifier,
          summary: "Verifier status: blocked (build canceled).",
          branch: builderResult.branch,
          worktreePath: builderResult.worktreePath,
          ...(buildBase ? { base: buildBase } : {})
        });
        return {
          status: "blocked",
          verifierResults: canceledVerifier,
          branch: builderResult.branch,
          worktreePath: builderResult.worktreePath,
          ...(buildBase ? { base: buildBase } : {})
        };
      }

      if (!emittedCodexChunk) {
        input.runService.emit(run, "codex_stream", {
          runId: handoff.runId,
          chunk: builderResult.lastMessage.trim() || `Codex exited with code ${builderResult.exitCode ?? "null"}.`
        });
      }

      if (builderResult.timedOut) {
        input.runService.emit(run, "codex_stream", {
          runId: handoff.runId,
          chunk: `\nCodex build aborted (${builderResult.timedOut} timeout); killed the build process group.`
        });
        if (builderResult.cleanupFailed) {
          input.runService.emit(run, "codex_stream", {
            runId: handoff.runId,
            chunk: `\nWARNING: failed to remove the timed-out build worktree at ${builderResult.worktreePath}; it may be leaked and need manual cleanup.`
          });
        }
        const timeoutVerifier = [
          {
            name: "codex",
            status: "blocked" as const,
            output:
              builderResult.timedOut === "wall"
                ? `build timeout: wall (${formatWall(buildWallMs)})`
                : `build timeout: ${builderResult.timedOut}`
          }
        ];
        input.runService.emit(run, "verifier_result", {
          runId: handoff.runId,
          status: "blocked",
          verifierResults: timeoutVerifier,
          summary: `Verifier status: blocked (Codex ${builderResult.timedOut} timeout).`,
          branch: builderResult.branch,
          worktreePath: builderResult.worktreePath,
          ...(buildBase ? { base: buildBase } : {})
        });
        return {
          status: "blocked",
          verifierResults: timeoutVerifier,
          branch: builderResult.branch,
          worktreePath: builderResult.worktreePath,
          ...(buildBase ? { base: buildBase } : {})
        };
      }

      if (builderResult.exitCode !== 0) {
        // A non-zero, non-timeout Codex exit is a hard build failure: do not run acceptance verifiers
        // against a failed build. runCodexBuilder already tore down the leaked worktree (non-throwing),
        // so surface any cleanup failure as a warning instead of rejecting past this fail emit.
        if (builderResult.cleanupFailed) {
          input.runService.emit(run, "codex_stream", {
            runId: handoff.runId,
            chunk: `\nWARNING: failed to remove the failed build worktree at ${builderResult.worktreePath}; it may be leaked and need manual cleanup.`
          });
        }
        const failVerifier = [
          {
            name: "codex",
            status: "fail" as const,
            output: `Codex exited with code ${builderResult.exitCode ?? "null"}.`
          }
        ];
        input.runService.emit(run, "verifier_result", {
          runId: handoff.runId,
          status: "fail",
          verifierResults: failVerifier,
          summary: `Verifier status: fail (Codex exit ${builderResult.exitCode ?? "null"}).`,
          branch: builderResult.branch,
          worktreePath: builderResult.worktreePath,
          ...(buildBase ? { base: buildBase } : {})
        });
        return {
          status: "fail",
          verifierResults: failVerifier,
          branch: builderResult.branch,
          worktreePath: builderResult.worktreePath,
          ...(buildBase ? { base: buildBase } : {})
        };
      }

      if (builderResult.scopeViolations.length > 0) {
        const detail = builderResult.scopeViolations.map((v) => `${v.path} (${v.reason})`).join(", ");
        input.runService.emit(run, "codex_stream", {
          runId: handoff.runId,
          chunk: `\nCodex build rejected: out-of-scope writes — ${detail}. Not committed; cycle failed.`
        });
        const scopeVerifier = [{ name: "write-scope", status: "fail" as const, output: `out-of-scope writes: ${detail}` }];
        input.runService.emit(run, "verifier_result", {
          runId: handoff.runId,
          status: "fail",
          verifierResults: scopeVerifier,
          summary: `Verifier status: fail (write-scope: ${builderResult.scopeViolations.length} violation(s)).`,
          branch: builderResult.branch,
          worktreePath: builderResult.worktreePath,
          ...(buildBase ? { base: buildBase } : {})
        });
        return {
          status: "fail",
          verifierResults: scopeVerifier,
          branch: builderResult.branch,
          worktreePath: builderResult.worktreePath,
          ...(buildBase ? { base: buildBase } : {}),
          scopeViolations: builderResult.scopeViolations
        };
      }

      // The build produced a committed branch. Diff its test change against the base the worktree
      // forked from (base..branch), deterministically (git + text, no model judgment), and surface it
      // as a test_delta run event the orchestrator persists; the sign-off gate blocks a weakened
      // delta without an explicit acknowledgment.
      // Fail CLOSED: with no resolvable base we cannot prove the tests were not weakened, so emit a
      // weakened delta that forces acknowledgment rather than silently skipping the gate. A normal
      // build (base resolves, source-only or pure-addition test changes) carries a non-weakened
      // delta and flows through untouched.
      const testDelta: TestDelta = buildBase
        ? await computeTestDelta({
            targetRepo,
            branch: builderResult.branch,
            base: buildBase,
            git: gitRunner
          })
        : {
            weakened: true,
            signals: [
              "build base commit could not be resolved; test changes could not be verified — acknowledgment required"
            ],
            addedTests: 0,
            removedTests: 0,
            deletedTestFiles: []
          };
      input.runService.emit(run, "test_delta", { runId: handoff.runId, testDelta });

      // Reuse the target repo's installed node_modules so the verifier skips a fresh `npm ci` (the
      // heavy, network-fragile part). Usually a no-op now that the build phase links first
      // ("worktree already has node_modules"); it self-heals a worktree the builder stripped.
      // Best-effort + orchestrator-internal: a failure just leaves the verifier to install.
      // Logged server-side (not into the build transcript) for ops diagnosis.
      const linkResult = await linkNodeModules({
        targetRepo,
        worktreePath: builderResult.worktreePath,
        git: gitRunner
      });
      console.log(
        linkResult.linked
          ? `PlanForge: linked node_modules into the verify worktree (${linkResult.dest}).`
          : `PlanForge: did not link verify node_modules (${linkResult.reason ?? "unknown"}); the verifier command installs if needed.`
      );

      const verifierResults = await runAcceptanceVerifiers({
        worktreePath: builderResult.worktreePath,
        commands: verifierCommands,
        runner: input.verifierRunner,
        timeoutMs: verifierTimeoutMs
      });
      const status = aggregateStatus(verifierResults);
      input.runService.emit(run, "verifier_result", {
        runId: handoff.runId,
        status,
        verifierResults,
        summary: `Verifier status: ${status}.`,
        branch: builderResult.branch,
        worktreePath: builderResult.worktreePath,
        ...(buildBase ? { base: buildBase } : {})
      });

      return {
        status,
        verifierResults,
        branch: builderResult.branch,
        worktreePath: builderResult.worktreePath,
        ...(buildBase ? { base: buildBase } : {}),
        testDelta
      };
    };

    try {
      return await runBuilderBody();
    } catch (error) {
      // The builder threw after marking the build in flight (a codex_stream already fired) but before
      // any terminal run event. Emit a terminal "error" so the orchestrator settles buildInFlight and
      // re-arms the idle reaper, then re-throw the ORIGINAL cause so the MCP handoff still rejects with
      // it. Without this the reaper stays paused forever and the conversation is never reaped.
      input.runService.emit(run, "error", {
        runId: handoff.runId,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };
}
