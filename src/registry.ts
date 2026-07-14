import { createHash } from "node:crypto";
import { PlanForgeError } from "./errors";
import type {
  ApprovalResult,
  CodexHandoff,
  HandoffResult,
  PlanProposal,
  SignOffInput,
  SignOffResult,
  TestDelta,
  VerifierResult
} from "./domain";

// A fingerprint of the build-determining handoff fields (everything but runId). An exact retry of a
// dropped handoff_to_codex call carries identical content and so hashes identically; a genuinely new
// objective in the same conversation hashes differently and builds fresh.
function handoffFingerprint(handoff: CodexHandoff): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        project: handoff.project,
        objective: handoff.objective,
        context: handoff.context,
        constraints: handoff.constraints,
        verification: handoff.verification,
        stop_conditions: handoff.stop_conditions
      })
    )
    .digest("hex");
}

type PendingApproval = {
  readonly proposal: PlanProposal;
  readonly resolve: (result: ApprovalResult) => void;
  readonly reject: (error: Error) => void;
};

export type RunBuilderOptions = {
  // Aborting cancels an in-flight build immediately (operator stop / conversation teardown) instead
  // of leaving it to run to the build wall.
  readonly signal?: AbortSignal;
};

export type RunBuilder = (handoff: CodexHandoff, options?: RunBuilderOptions) => Promise<HandoffResult>;

export type CreatePlanForgeRegistryOptions = {
  readonly runBuilder?: RunBuilder;
};

async function blockedBuilder(): Promise<HandoffResult> {
  return {
    status: "blocked",
    verifierResults: [{ name: "codex", status: "blocked", output: "No builder driver configured." }]
  };
}

export function createPlanForgeRegistry(options: CreatePlanForgeRegistryOptions = {}) {
  const pendingApprovals = new Map<string, PendingApproval>();
  const verifierResults = new Map<string, readonly VerifierResult[]>();
  const testDeltas = new Map<string, TestDelta>();
  const handoffResults = new Map<string, HandoffResult>();
  // In-flight (and settled-but-not-yet-evicted) builds keyed on `${runId}:${handoffFingerprint}`.
  // The architect's handoff_to_codex MCP call is held open for the whole multi-minute build; if that
  // long POST drops, the architect re-issues the IDENTICAL handoff. Without this an exact retry would
  // spawn a second Codex worktree (the two-writer hazard). Keying on content keeps distinct cycles in
  // one conversation independent while making an exact retry join the original build.
  const buildsByKey = new Map<string, { readonly promise: Promise<HandoffResult>; readonly controller: AbortController }>();
  // The set of build keys created for each runId, so evict() can clear/abort them all on teardown.
  const buildKeysByRun = new Map<string, Set<string>>();
  // Runs whose conversation was torn down. A build resolution arriving AFTER eviction (a late
  // builder resolution following a mid-build architect crash) must not re-insert into the maps
  // evict() just cleared, or the per-run state leaks back in after teardown.
  const evicted = new Set<string>();
  const runBuilder = options.runBuilder ?? blockedBuilder;

  function proposePlan(proposal: PlanProposal): Promise<ApprovalResult> {
    if (pendingApprovals.has(proposal.runId)) {
      throw new PlanForgeError("E_APPROVAL_PENDING", `Approval already pending for ${proposal.runId}.`);
    }
    return new Promise((resolve, reject) => {
      pendingApprovals.set(proposal.runId, { proposal, resolve, reject });
    });
  }

  function resolveApproval(result: ApprovalResult): ApprovalResult {
    const pending = pendingApprovals.get(result.runId);
    if (!pending) {
      throw new PlanForgeError("E_APPROVAL_NOT_FOUND", `No pending proposal for ${result.runId}.`);
    }
    pendingApprovals.delete(result.runId);
    pending.resolve(result);
    return result;
  }

  // Settle an outstanding approval on teardown so the architect's awaiting MCP call rejects
  // instead of hanging forever once its conversation is reaped, stopped, or crashes.
  function cancelApproval(runId: string): boolean {
    const pending = pendingApprovals.get(runId);
    if (!pending) {
      return false;
    }
    pendingApprovals.delete(runId);
    pending.reject(new PlanForgeError("E_APPROVAL_CANCELED", `Approval for ${runId} was canceled before a verdict.`));
    return true;
  }

  function handoffToCodex(handoff: CodexHandoff): Promise<HandoffResult> {
    const key = `${handoff.runId}:${handoffFingerprint(handoff)}`;
    // Idempotent on (runId + content): a re-issued identical handoff joins the in-flight build (or
    // returns its already-settled result) instead of spawning a second Codex worktree. This is the
    // keystone that makes recovery from a dropped long-held handoff_to_codex call safe to retry.
    const existing = buildsByKey.get(key);
    if (existing) {
      return existing.promise;
    }
    // One AbortController per build; evict() aborts it so stopping a conversation cancels an in-flight
    // build immediately rather than leaving it to run to the build wall.
    const controller = new AbortController();
    const build = runBuilder(handoff, { signal: controller.signal }).then((result) => {
      // A resolution that lands after the run was evicted (mid-build architect crash + late builder
      // resolution) must not re-populate the maps eviction cleared. Guard the write-back.
      if (!evicted.has(handoff.runId)) {
        handoffResults.set(handoff.runId, result);
        verifierResults.set(handoff.runId, result.verifierResults);
        // Keep testDeltas in lockstep with verifierResults (set unconditionally above): a resolution
        // WITHOUT a delta — a fail/blocked build that never reached the diff — clears any stale delta
        // from a prior cycle so it can never mis-gate a later sign_off in the same conversation.
        if (result.testDelta !== undefined) {
          testDeltas.set(handoff.runId, result.testDelta);
        } else {
          testDeltas.delete(handoff.runId);
        }
      }
      return result;
    });
    // A build that REJECTS (threw — runCodexBuilder already tore its worktree down) must not stay
    // cached as the permanent answer; drop the key so a later retry can re-attempt cleanly. A build
    // that RESOLVES to fail/blocked stays cached: retrying the identical handoff would fail again.
    build.catch(() => {
      if (buildsByKey.get(key)?.promise === build) {
        buildsByKey.delete(key);
      }
    });
    buildsByKey.set(key, { promise: build, controller });
    let keys = buildKeysByRun.get(handoff.runId);
    if (!keys) {
      keys = new Set();
      buildKeysByRun.set(handoff.runId, keys);
    }
    keys.add(key);
    return build;
  }

  // A completed cycle (sign_off-driven merge landed) ends the life of its build. Drop the cached
  // build promise(s) for the run — but NOT the tombstone, and NOT handoffResults/verifierResults
  // (those persist until evict, overwritten by the next build) — so the NEXT handoff in this
  // conversation, even one whose content is byte-identical to a just-merged cycle, rebuilds instead
  // of returning a stale already-merged result. Without this the (runId + content) cache outlives the
  // cycle and a legitimate "rebuild it the same way" silently returns a phantom completed build.
  function clearBuildCache(runId: string): void {
    const keys = buildKeysByRun.get(runId);
    if (!keys) {
      return;
    }
    for (const key of keys) {
      buildsByKey.delete(key);
    }
    buildKeysByRun.delete(runId);
  }

  // Drop all per-run registry state on conversation teardown so handoffResults/verifierResults/
  // pendingApprovals/builds do not grow unbounded across the life of the process.
  function evict(runId: string): void {
    cancelApproval(runId);
    handoffResults.delete(runId);
    verifierResults.delete(runId);
    testDeltas.delete(runId);
    const keys = buildKeysByRun.get(runId);
    if (keys) {
      for (const key of keys) {
        // Cancel an in-flight build for this run (stop / reap / architect-crash mid-build) so it is
        // killed at once instead of running to the build wall. Aborting an already-settled build's
        // controller is a harmless no-op.
        buildsByKey.get(key)?.controller.abort();
        buildsByKey.delete(key);
      }
      buildKeysByRun.delete(runId);
    }
    // Tombstone the run so a build resolution still in flight cannot re-insert what we just cleared.
    evicted.add(runId);
  }

  function signOff(input: SignOffInput): SignOffResult {
    const results = verifierResults.get(input.runId) ?? [];
    if (results.length === 0 || results.some((result) => result.status !== "pass")) {
      throw new PlanForgeError("E_SIGN_OFF_BLOCKED", "sign_off requires every verifier result to be pass.");
    }
    // A build cannot be signed off with WEAKENED test coverage unless the architect consciously
    // acknowledges it. Tests are builder-writable, so this is the mechanical teeth that stops a
    // builder from deleting/disabling the tests it cannot pass and self-grading green: an
    // independent actor must re-call sign_off with acknowledgeTestChanges after reviewing the diff.
    // Normal test evolution and pure additions carry a non-weakened delta and flow through untouched.
    const delta = testDeltas.get(input.runId);
    if (delta?.weakened === true && input.acknowledgeTestChanges !== true) {
      const signals = delta.signals.length > 0 ? delta.signals.join("; ") : "weakened test coverage detected";
      throw new PlanForgeError(
        "E_SIGN_OFF_BLOCKED",
        `sign_off is blocked: this build weakened test coverage (${signals}). Review the test diff, then re-call sign_off with acknowledgeTestChanges:true only if the weakening is justified.`
      );
    }
    return { runId: input.runId, status: "signed_off", grade: input.grade };
  }

  return {
    proposePlan,
    resolveApproval,
    cancelApproval,
    clearBuildCache,
    evict,
    handoffToCodex,
    signOff,
    pendingApprovalsCount(): number {
      return pendingApprovals.size;
    },
    verifierResultsFor(runId: string): readonly VerifierResult[] {
      return verifierResults.get(runId) ?? [];
    },
    testDeltaFor(runId: string): TestDelta | null {
      return testDeltas.get(runId) ?? null;
    },
    handoffResultFor(runId: string): HandoffResult | null {
      return handoffResults.get(runId) ?? null;
    },
    markHandoffMerged(runId: string): void {
      const result = handoffResults.get(runId);
      if (result) {
        handoffResults.set(runId, { ...result, merged: true });
      }
    }
  };
}

export type PlanForgeRegistry = ReturnType<typeof createPlanForgeRegistry>;
