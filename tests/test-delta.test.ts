import { describe, expect, it } from "vitest";
import type { GitRunner } from "../src/builder/codex-driver";
import { computeTestDelta, isTestPath, parseNameStatus } from "../src/builder/test-delta";

const BASE = "basesha";
const BRANCH = "planforge/run-1";

// A fake git that answers exactly the two calls computeTestDelta makes: the name-status diff, and
// `show <ref>:<path>` for old/new file content. Diffs and contents are canned per test — no real
// git, no worktree. `contents` maps `${ref}:${path}` to the file text at that ref; a missing key
// makes `show` throw (git's behavior for a path absent at a ref), which the detector treats as empty.
function fakeGit(input: {
  readonly nameStatus: string;
  readonly contents: Readonly<Record<string, string>>;
}): { readonly git: GitRunner; readonly calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push([...args]);
    if (args.includes("diff")) {
      return { stdout: input.nameStatus, stderr: "" };
    }
    if (args.includes("show")) {
      const spec = args[args.length - 1] as string; // "<ref>:<path>"
      const content = input.contents[spec];
      if (content === undefined) {
        throw new Error(`fatal: path does not exist in ${spec}`);
      }
      return { stdout: content, stderr: "" };
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  return { git, calls };
}

// -z name-status records are NUL-separated. A modify/add/delete is "STATUS\0path"; a rename is
// "Rnnn\0old\0new". The list is joined with NUL and terminated by a trailing NUL.
function nameStatus(records: readonly string[]): string {
  return records.length === 0 ? "" : `${records.join("\0")}\0`;
}

const TWO_CASES_TWO_ASSERTS = [
  "it('a', () => { expect(1).toBe(1); });",
  "test('b', () => { expect(2).toBe(2); });"
].join("\n");

describe("computeTestDelta", () => {
  it("flags a deleted test file as weakened and counts its removed cases", async () => {
    const { git } = fakeGit({
      nameStatus: nameStatus(["D\0tests/gone.test.ts"]),
      contents: { [`${BASE}:tests/gone.test.ts`]: TWO_CASES_TWO_ASSERTS }
    });
    const delta = await computeTestDelta({ targetRepo: "/repo", branch: BRANCH, base: BASE, git });

    expect(delta.weakened).toBe(true);
    expect(delta.deletedTestFiles).toEqual(["tests/gone.test.ts"]);
    expect(delta.removedTests).toBe(2);
    expect(delta.addedTests).toBe(0);
    expect(delta.signals).toEqual(["deleted test file: tests/gone.test.ts"]);
  });

  it("flags a count-preserving assertion gut as weakened (not append-only)", async () => {
    // Same case count and same expect( count before/after — the flat-token-count evasion — but the
    // assertion's meaning was gutted (expect(sum(2,2)).toBe(4) -> expect(true).toBe(true)).
    const before = "it('adds', () => { expect(sum(2, 2)).toBe(4); });";
    const after = "it('adds', () => { expect(true).toBe(true); });";
    const { git } = fakeGit({
      nameStatus: nameStatus(["M\0tests/math.test.ts"]),
      contents: { [`${BASE}:tests/math.test.ts`]: before, [`${BRANCH}:tests/math.test.ts`]: after }
    });
    const delta = await computeTestDelta({ targetRepo: "/repo", branch: BRANCH, base: BASE, git });

    expect(delta.weakened).toBe(true);
    expect(delta.signals.some((s) => s.includes("not an append-only change"))).toBe(true);
  });

  it("flags an interleaved insertion that neuters a live assertion (if(false) wrapper) as weakened", async () => {
    // The insertion dual of the gut: NO existing line is edited or removed — a disabling wrapper is
    // inserted around a live assertion. Counts stay flat and every base line is still present, so a
    // subsequence check would pass it; the contiguous-prefix (append-only) check catches it.
    const before = ["it('adds', () => {", "  expect(sum(2, 2)).toBe(4);", "});"].join("\n");
    const after = ["it('adds', () => {", "  if (false) {", "  expect(sum(2, 2)).toBe(4);", "  }", "});"].join("\n");
    const { git } = fakeGit({
      nameStatus: nameStatus(["M\0tests/math.test.ts"]),
      contents: { [`${BASE}:tests/math.test.ts`]: before, [`${BRANCH}:tests/math.test.ts`]: after }
    });
    const delta = await computeTestDelta({ targetRepo: "/repo", branch: BRANCH, base: BASE, git });

    expect(delta.weakened).toBe(true);
    expect(delta.signals.some((s) => s.includes("not an append-only change"))).toBe(true);
  });

  it("treats appending to the end of an existing test file as append-only (not weakened)", async () => {
    const before = TWO_CASES_TWO_ASSERTS;
    const after = `${TWO_CASES_TWO_ASSERTS}\nit('c', () => { expect(3).toBe(3); });`;
    const { git } = fakeGit({
      nameStatus: nameStatus(["M\0tests/suite.test.ts"]),
      contents: { [`${BASE}:tests/suite.test.ts`]: before, [`${BRANCH}:tests/suite.test.ts`]: after }
    });
    const delta = await computeTestDelta({ targetRepo: "/repo", branch: BRANCH, base: BASE, git });

    expect(delta.weakened).toBe(false);
    expect(delta.signals).toEqual([]);
    expect(delta.addedTests).toBe(1);
  });

  it("flags a net decrease in test cases and assertions as weakened", async () => {
    const { git } = fakeGit({
      nameStatus: nameStatus(["M\0src/thing.test.ts"]),
      contents: {
        [`${BASE}:src/thing.test.ts`]: TWO_CASES_TWO_ASSERTS,
        // One case, one assertion — a real weakening of an existing file.
        [`${BRANCH}:src/thing.test.ts`]: "it('a', () => { expect(1).toBe(1); });"
      }
    });
    const delta = await computeTestDelta({ targetRepo: "/repo", branch: BRANCH, base: BASE, git });

    expect(delta.weakened).toBe(true);
    expect(delta.removedTests).toBe(1);
    expect(delta.addedTests).toBe(0);
    expect(delta.signals).toEqual([
      "fewer test cases in src/thing.test.ts: 2 -> 1",
      "fewer assertions in src/thing.test.ts: 2 -> 1",
      "test file src/thing.test.ts was modified (not an append-only change; existing content edited or code inserted above the end) — review required"
    ]);
    expect(delta.deletedTestFiles).toEqual([]);
  });

  it("flags a newly added .only() as weakened (it silently disables siblings)", async () => {
    const { git } = fakeGit({
      nameStatus: nameStatus(["M\0src/thing.test.ts"]),
      contents: {
        [`${BASE}:src/thing.test.ts`]: TWO_CASES_TWO_ASSERTS,
        // Same two cases + assertions, but one is now focused with .only — no count drop, still weak.
        [`${BRANCH}:src/thing.test.ts`]: [
          "it.only('a', () => { expect(1).toBe(1); });",
          "test('b', () => { expect(2).toBe(2); });"
        ].join("\n")
      }
    });
    const delta = await computeTestDelta({ targetRepo: "/repo", branch: BRANCH, base: BASE, git });

    expect(delta.weakened).toBe(true);
    expect(delta.signals).toEqual([
      "added .only() in src/thing.test.ts (disables sibling tests): 0 -> 1",
      "test file src/thing.test.ts was modified (not an append-only change; existing content edited or code inserted above the end) — review required"
    ]);
    expect(delta.removedTests).toBe(0);
  });

  it("does not flag pure additions (new test file + added cases) as weakened", async () => {
    const { git } = fakeGit({
      nameStatus: nameStatus(["A\0tests/new.test.ts", "M\0src/thing.test.ts"]),
      contents: {
        // New file (absent at base): its show at base throws → treated as empty.
        [`${BRANCH}:tests/new.test.ts`]: TWO_CASES_TWO_ASSERTS,
        // Existing file grows from one case to three — additive, not weakening.
        [`${BASE}:src/thing.test.ts`]: "it('a', () => { expect(1).toBe(1); });",
        [`${BRANCH}:src/thing.test.ts`]: [
          "it('a', () => { expect(1).toBe(1); });",
          "it('b', () => { expect(2).toBe(2); });",
          "it('c', () => { expect(3).toBe(3); });"
        ].join("\n")
      }
    });
    const delta = await computeTestDelta({ targetRepo: "/repo", branch: BRANCH, base: BASE, git });

    expect(delta.weakened).toBe(false);
    expect(delta.signals).toEqual([]);
    // 2 new cases in the added file + 2 net new in the modified file.
    expect(delta.addedTests).toBe(4);
    expect(delta.removedTests).toBe(0);
    expect(delta.deletedTestFiles).toEqual([]);
  });

  it("reports no weakening and zero signals when no test files changed", async () => {
    // A source-only build: the test-restricted diff comes back empty.
    const { git, calls } = fakeGit({ nameStatus: nameStatus([]), contents: {} });
    const delta = await computeTestDelta({ targetRepo: "/repo", branch: BRANCH, base: BASE, git });

    expect(delta).toEqual({
      weakened: false,
      signals: [],
      addedTests: 0,
      removedTests: 0,
      deletedTestFiles: []
    });
    // No file content was fetched — only the single diff call was made.
    expect(calls.filter((args) => args.includes("show"))).toEqual([]);
  });

  it("ignores non-test paths that slip into the diff output", async () => {
    // The pathspec should keep source files out, but if one appears the detector must skip it.
    const { git } = fakeGit({
      nameStatus: nameStatus(["M\0src/thing.ts", "D\0docs/readme.md"]),
      contents: {}
    });
    const delta = await computeTestDelta({ targetRepo: "/repo", branch: BRANCH, base: BASE, git });

    expect(delta.weakened).toBe(false);
    expect(delta.deletedTestFiles).toEqual([]);
  });
});

describe("isTestPath", () => {
  it("matches tests/ dirs at any depth and .test.ts/.tsx suffixes", () => {
    expect(isTestPath("tests/a.ts")).toBe(true);
    expect(isTestPath("packages/x/tests/a.ts")).toBe(true);
    expect(isTestPath("src/App.test.ts")).toBe(true);
    expect(isTestPath("src/App.test.tsx")).toBe(true);
    expect(isTestPath("./tests/a.ts")).toBe(true);
  });

  it("does not match ordinary source or near-miss names", () => {
    expect(isTestPath("src/App.tsx")).toBe(false);
    expect(isTestPath("src/testing.ts")).toBe(false);
    expect(isTestPath("src/latest.ts")).toBe(false);
  });
});

describe("parseNameStatus", () => {
  it("parses modify/add/delete and rename records from -z output", () => {
    expect(parseNameStatus(nameStatus(["M\0a.test.ts", "A\0tests/b.ts", "D\0tests/c.ts"]))).toEqual([
      { status: "M", oldPath: "a.test.ts", newPath: "a.test.ts" },
      { status: "A", oldPath: "tests/b.ts", newPath: "tests/b.ts" },
      { status: "D", oldPath: "tests/c.ts", newPath: "tests/c.ts" }
    ]);
    // Rename layout: Rnnn, old path, new path.
    expect(parseNameStatus(`R096\0tests/old.test.ts\0tests/new.test.ts\0`)).toEqual([
      { status: "R096", oldPath: "tests/old.test.ts", newPath: "tests/new.test.ts" }
    ]);
  });

  it("returns nothing for empty diff output", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});
