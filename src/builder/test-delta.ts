// Deterministic test-weakening detector for the self-evolution loop. Tests are builder-writable
// (see ./write-scope), so a build that cannot pass the real tests must never be able to quietly
// gut them and self-grade green. This module diffs the build branch against the commit its worktree
// forked from and, using ONLY git + text (no model judgment), reports whether the test change
// weakened coverage. run-builder surfaces the result; a later gate decides what to do with it.
//
// Weakening signals (any one → weakened):
//   - a test file was deleted;
//   - a changed test file's test-case count (it(/test() dropped;
//   - a changed test file's assertion count (expect() dropped;
//   - a changed test file gained a `.only(` (silently disables its siblings) or a
//     `.skip(` / `xit(` / `xtest(` (silently disables that case).
// Pure additions — new test files, or added cases/assertions with none removed — are NOT weakening.

import type { TestDelta } from "../domain";
import type { GitRunner } from "./codex-driver";

export type { TestDelta };

export type ComputeTestDeltaInput = {
  readonly targetRepo: string;
  // The build branch (e.g. planforge/<runId>) whose test change is under review.
  readonly branch: string;
  // The commit the build worktree forked from — run-builder creates it with
  // `git worktree add <path> -b <branch> HEAD`, so this is that HEAD sha. The diff is base..branch.
  readonly base: string;
  readonly git: GitRunner;
};

// A path is a test if it lives under a tests/ directory (at any depth) or ends in .test.ts/.test.tsx.
// Mirrors the historical write-scope test globs so the same files the builder may now write are the
// ones the delta watches.
export function isTestPath(candidate: string): boolean {
  const path = candidate.replace(/^\.\//, "");
  if (/\.test\.tsx?$/.test(path)) {
    return true;
  }
  return path === "tests" || path.startsWith("tests/") || path.includes("/tests/");
}

function countMatches(content: string, pattern: RegExp): number {
  const matches = content.match(pattern);
  return matches === null ? 0 : matches.length;
}

// Test cases: it(...) / test(...) as call heads, INCLUDING modifier chains like it.only(...),
// test.skip(...), it.each([...])(... — an it.only is still a case, so counting it keeps the
// case-count stable and lets the dedicated .only/.skip signals (not a spurious "fewer cases") fire.
// \b anchors so `submit(` or `awaitIt(` do not match.
const TEST_CASE_RE = /\b(?:it|test)(?:\.[A-Za-z]+)*\s*\(/g;
// Assertions: expect(...) as a call head.
const ASSERTION_RE = /\bexpect\s*\(/g;
// A focused test silently disables its siblings.
const ONLY_RE = /\.only\s*\(/g;
// Skipped tests silently disable that case (.skip(, and the jasmine/xit spellings xit( / xtest().
const SKIP_RE = /(?:\.skip\s*\(|\bxit\s*\(|\bxtest\s*\()/g;

type TestCounts = {
  readonly cases: number;
  readonly assertions: number;
  readonly only: number;
  readonly skip: number;
};

function countTest(content: string): TestCounts {
  return {
    cases: countMatches(content, TEST_CASE_RE),
    assertions: countMatches(content, ASSERTION_RE),
    only: countMatches(content, ONLY_RE),
    skip: countMatches(content, SKIP_RE)
  };
}

// Lines of a file with the trailing empty element from a final newline dropped, so an appended file
// compares cleanly against its shorter original.
function linesOf(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// A modified file is APPEND-ONLY when the base version is a contiguous PREFIX of the new version:
// every base line is byte-identical and in its original position, and all new content sits strictly
// at the end. This is deliberately stricter than an order-preserving subsequence. A subsequence check
// permits INTERLEAVED insertions, which is enough to neuter an existing assertion without editing or
// removing any line — e.g. inserting `if (false) {` above a live `expect(...)` and `}` below it keeps
// every base line present and in order yet renders the assertion dead. Requiring a contiguous prefix
// means any such interleaving (or any edit to an existing line) breaks append-only and routes the
// change through the acknowledgment gate; only genuine end-of-file additions flow through untouched.
function isAppendOnly(before: string, after: string): boolean {
  const baseLines = linesOf(before);
  const nextLines = linesOf(after);
  if (nextLines.length < baseLines.length) {
    return false;
  }
  for (let i = 0; i < baseLines.length; i += 1) {
    if (nextLines[i] !== baseLines[i]) {
      return false;
    }
  }
  return true;
}

// `git show <ref>:<path>` for a file that does not exist at that ref exits non-zero; treat any such
// failure as "absent at that ref" (empty content) so an added file (absent at base) and a deleted
// file (absent at branch) are both handled without a special case.
async function showAtRef(git: GitRunner, targetRepo: string, ref: string, filePath: string): Promise<string> {
  try {
    const result = await git(["-C", targetRepo, "show", `${ref}:${filePath}`]);
    return result.stdout;
  } catch {
    return "";
  }
}

// Parse `git diff --name-status -z` output. NUL-separated fields: a status token (M/A/D/... or
// Rnnn/Cnnn for rename/copy with a similarity index) followed by one path, or — for rename/copy —
// the source path then the destination path.
type DiffEntry = { readonly status: string; readonly oldPath: string; readonly newPath: string };

export function parseNameStatus(stdout: string): DiffEntry[] {
  const fields = stdout.split("\0");
  const entries: DiffEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i];
    if (status === undefined || status.length === 0) {
      i += 1;
      continue;
    }
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = fields[i + 1];
      const newPath = fields[i + 2];
      i += 3;
      if (oldPath !== undefined && oldPath.length > 0 && newPath !== undefined && newPath.length > 0) {
        entries.push({ status, oldPath, newPath });
      }
      continue;
    }
    const filePath = fields[i + 1];
    i += 2;
    if (filePath !== undefined && filePath.length > 0) {
      entries.push({ status, oldPath: filePath, newPath: filePath });
    }
  }
  return entries;
}

export async function computeTestDelta(input: ComputeTestDeltaInput): Promise<TestDelta> {
  const { targetRepo, branch, base, git } = input;
  // Restrict the diff to test paths at the git layer so a large source-only change is never scanned.
  const diff = await git([
    "-C",
    targetRepo,
    "diff",
    "--name-status",
    "-z",
    base,
    branch,
    "--",
    "*.test.ts",
    "*.test.tsx",
    "tests/**",
    "**/tests/**"
  ]);
  const entries = parseNameStatus(diff.stdout);

  const signals: string[] = [];
  const deletedTestFiles: string[] = [];
  let addedTests = 0;
  let removedTests = 0;

  for (const entry of entries) {
    // A rename can move a non-test into tests/ or vice versa; consider the entry if EITHER side is a
    // test path, and count content only on the sides that are actually tests.
    const oldIsTest = isTestPath(entry.oldPath);
    const newIsTest = isTestPath(entry.newPath);
    if (!oldIsTest && !newIsTest) {
      continue;
    }

    if (entry.status[0] === "D") {
      deletedTestFiles.push(entry.oldPath);
      const before = countTest(await showAtRef(git, targetRepo, base, entry.oldPath));
      removedTests += before.cases;
      signals.push(`deleted test file: ${entry.oldPath}`);
      continue;
    }

    const beforeContent = oldIsTest ? await showAtRef(git, targetRepo, base, entry.oldPath) : "";
    const afterContent = newIsTest ? await showAtRef(git, targetRepo, branch, entry.newPath) : "";
    const before = countTest(beforeContent);
    const after = countTest(afterContent);

    addedTests += Math.max(after.cases - before.cases, 0);
    removedTests += Math.max(before.cases - after.cases, 0);

    if (after.cases < before.cases) {
      signals.push(`fewer test cases in ${entry.newPath}: ${before.cases} -> ${after.cases}`);
    }
    if (after.assertions < before.assertions) {
      signals.push(`fewer assertions in ${entry.newPath}: ${before.assertions} -> ${after.assertions}`);
    }
    if (after.only > before.only) {
      signals.push(`added .only() in ${entry.newPath} (disables sibling tests): ${before.only} -> ${after.only}`);
    }
    if (after.skip > before.skip) {
      signals.push(`added skipped test in ${entry.newPath}: ${before.skip} -> ${after.skip}`);
    }
    // Count-preserving neutering (rewriting an assertion body, swapping a real expectation for a
    // trivial one, or wrapping a live assertion in `if (false) { … }`) keeps every count above flat
    // and would slip through; require that an EXISTING test file only GREW AT THE END. Any edit to an
    // existing line, or any insertion above the end, breaks append-only and is a change that must be
    // consciously reviewed. Added files are handled above and never reach here (a new file's base is
    // empty → append-only is trivially true).
    if (oldIsTest && newIsTest && entry.status[0] !== "A" && !isAppendOnly(beforeContent, afterContent)) {
      signals.push(`test file ${entry.newPath} was modified (not an append-only change; existing content edited or code inserted above the end) — review required`);
    }
  }

  return {
    weakened: signals.length > 0,
    signals,
    addedTests,
    removedTests,
    deletedTestFiles
  };
}
