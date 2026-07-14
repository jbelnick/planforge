// Machine-enforced blast-radius guard for the Codex builder. After a build, the set of
// changed worktree paths is checked against this policy BEFORE any commit/merge: a write to
// a protected path or — when an allow-list is set — outside it fails the cycle, so a runaway
// builder can never land changes the architect did not scope. See DEFAULT_PROTECTED_GLOBS below
// for why tests are writable but ACCEPTANCE.md + the verifier spec stay protected.

import { VERIFIER_SPEC_FILENAME } from "../verifier-spec";

export type WriteScopeReason = "protected" | "not-allowed";

export type WriteScopeViolation = {
  readonly path: string;
  readonly reason: WriteScopeReason;
};

export type WriteScopePolicy = {
  // Paths the builder must never touch (wins over allowedGlobs).
  readonly protectedGlobs: readonly string[];
  // If non-empty, every changed path must match one of these or it is "not-allowed".
  readonly allowedGlobs: readonly string[];
};

// Tests are builder-WRITABLE: real self-evolution changes a feature's own tests, so blanket-
// protecting them would stop the loop from improving itself. The reward-hacking hole that opens
// is closed elsewhere by the test-delta gate (computeTestDelta in ./test-delta): a build that
// weakens or deletes tests is detected mechanically and can only be signed off with an independent
// actor's explicit acknowledgement. What stays protected here is the frozen grading contract that,
// if the builder could edit it, would let the builder redefine its own bar: ACCEPTANCE.md and the
// verifier spec (.planforge-verify.json). The spec is protected even though each cycle snapshots it
// from the target's own tree at handoff — without this gate a builder could commit a vacuous spec in
// its worktree, have it land via the sign-off merge, and be self-graded from the next cycle on.
// .git is never a build artifact.
export const DEFAULT_PROTECTED_GLOBS: readonly string[] = [
  "**/ACCEPTANCE.md",
  "ACCEPTANCE.md",
  `**/${VERIFIER_SPEC_FILENAME}`,
  VERIFIER_SPEC_FILENAME,
  ".git/**"
];

export function defaultWriteScopePolicy(): WriteScopePolicy {
  return { protectedGlobs: DEFAULT_PROTECTED_GLOBS, allowedGlobs: [] };
}

export function parseGlobList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          i += 1;
          source += "(?:.*/)?"; // ** spanning zero or more path segments
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*"; // * within a single segment
        i += 1;
      }
    } else if ("\\^$.|?+()[]{}".includes(char as string)) {
      source += `\\${char}`;
      i += 1;
    } else {
      source += char;
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesAny(globs: readonly string[], candidate: string): boolean {
  return globs.some((glob) => globToRegExp(glob).test(candidate));
}

export function evaluateWriteScope(
  changedPaths: readonly string[],
  policy: WriteScopePolicy
): WriteScopeViolation[] {
  const violations: WriteScopeViolation[] = [];
  for (const path of changedPaths) {
    const normalized = path.replace(/^\.\//, "");
    if (matchesAny(policy.protectedGlobs, normalized)) {
      violations.push({ path: normalized, reason: "protected" });
      continue;
    }
    if (policy.allowedGlobs.length > 0 && !matchesAny(policy.allowedGlobs, normalized)) {
      violations.push({ path: normalized, reason: "not-allowed" });
    }
  }
  return violations;
}

// Parses `git status --porcelain -z` output. The NUL machine format is never C-quoted, so paths
// with spaces / non-ASCII / quotes / backslashes survive verbatim (the porcelain v1 line format
// double-quotes those, which let a protected write slip past the scope gate). Each record is
// 2 status chars + 1 space + the raw path; for a rename ('R') or copy ('C'), the very next
// NUL-separated field is the ORIGIN path — both the destination and the origin are returned so the
// rename source is scope-checked too.
export function parsePorcelainPaths(stdout: string): string[] {
  const fields = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (record === undefined || record.length === 0) {
      continue; // drop the empty trailing field after the final NUL
    }
    if (record.length < 4) {
      continue; // not a "XY path" record
    }
    const status = record[0];
    paths.push(record.slice(3));
    if (status === "R" || status === "C") {
      const origin = fields[i + 1];
      i += 1;
      if (origin !== undefined && origin.length > 0) {
        paths.push(origin);
      }
    }
  }
  return paths;
}
