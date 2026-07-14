import type { JsonValue } from "./run-service";

export type ApprovalVerdict = "approved" | "changes_requested";
export type VerifierStatus = "pass" | "fail" | "blocked";

export type ApprovalResult = {
  readonly runId: string;
  readonly verdict: ApprovalVerdict;
  readonly reviewer?: string;
  readonly feedback?: string;
};

export type PlanProposal = {
  readonly runId: string;
  readonly title: string;
  readonly plan: string;
};

export type CodexHandoff = {
  readonly runId: string;
  readonly project: string;
  readonly objective: string;
  readonly context: string;
  readonly constraints: string;
  readonly verification: readonly string[];
  readonly stop_conditions: readonly string[];
};

export type VerifierResult = {
  readonly name: string;
  readonly status: VerifierStatus;
  readonly exitCode?: number | null;
  readonly output?: string;
};

// Deterministic diff of the build branch's test change against its base (see builder/test-delta).
// Detect-only for now: surfaced on the run so the architect/operator can see whether a build
// weakened test coverage; nothing gates on it yet.
export type TestDelta = {
  readonly weakened: boolean;
  readonly signals: readonly string[];
  readonly addedTests: number;
  readonly removedTests: number;
  readonly deletedTestFiles: readonly string[];
};

export type HandoffResult = {
  readonly status: VerifierStatus;
  readonly verifierResults: readonly VerifierResult[];
  readonly branch?: string;
  readonly worktreePath?: string;
  readonly base?: string;
  readonly scopeViolations?: readonly { readonly path: string; readonly reason: string }[];
  // The test-delta computed after the build produced a branch (absent when the build never reached a
  // committed branch — target re-validation failure, invalid spec, abort, timeout, non-zero exit).
  readonly testDelta?: TestDelta;
  // Set once the sign_off-driven merge lands: the result is kept until evict, so teardown needs
  // this to tell a completed cycle from a genuinely orphaned verified-but-unmerged build.
  readonly merged?: boolean;
};

export type SignOffInput = {
  readonly runId: string;
  readonly verdict: "pass";
  readonly grade: string;
  // Set true only after the architect has reviewed the actual test diff and judged a weakening
  // signal justified. A run whose stored TestDelta is weakened cannot be signed off without it; a
  // non-weakened (or absent) delta needs no acknowledgment. It is never a default.
  readonly acknowledgeTestChanges?: boolean;
};

export type SignOffResult = {
  readonly runId: string;
  readonly status: "signed_off";
  readonly grade: string;
};

export type DaemonAgentPayload =
  | { readonly type: "status"; readonly label: string; readonly model?: string; readonly ttftMs?: number; readonly detail?: string }
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "thinking_delta"; readonly delta: string }
  | { readonly type: "thinking_start" }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: JsonValue }
  | { readonly type: "tool_result"; readonly toolUseId: string; readonly content: string; readonly isError?: boolean }
  | {
      readonly type: "usage";
      readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
      readonly costUsd?: number;
      readonly durationMs?: number;
    }
  | { readonly type: "raw"; readonly line: string };
