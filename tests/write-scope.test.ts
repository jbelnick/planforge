import { describe, expect, it } from "vitest";
import {
  defaultWriteScopePolicy,
  evaluateWriteScope,
  parseGlobList,
  parsePorcelainPaths
} from "../src/builder/write-scope";

describe("write-scope policy", () => {
  it("flags the frozen grading contract and .git as protected", () => {
    const v = evaluateWriteScope(
      [
        "docs/x/ACCEPTANCE.md",
        "ACCEPTANCE.md",
        ".git/config"
      ],
      defaultWriteScopePolicy()
    );
    expect(v.map((x) => x.reason)).toEqual(["protected", "protected", "protected"]);
  });

  it("allows builder test writes by default (tests are writable, reviewed via the test-delta gate)", () => {
    // Tests were formerly blanket-protected; they are now builder-writable so self-evolution can
    // change a feature's own tests. Weakening is caught mechanically by computeTestDelta, not here.
    expect(
      evaluateWriteScope(
        [
          "projects/products/planforge/tests/chat-ui.test.tsx",
          "src/App.test.ts",
          "tests/write-scope.test.ts"
        ],
        defaultWriteScopePolicy()
      )
    ).toEqual([]);
  });

  it("protects the verifier spec at the root and at any depth by default", () => {
    // Without this, a builder could commit a vacuous .planforge-verify.json in its worktree, have
    // it land via the sign-off merge, and be self-graded from the next cycle on (each cycle's
    // handoff snapshot only protects the CURRENT cycle).
    const v = evaluateWriteScope(
      [".planforge-verify.json", "packages/app/.planforge-verify.json"],
      defaultWriteScopePolicy()
    );
    expect(v).toEqual([
      { path: ".planforge-verify.json", reason: "protected" },
      { path: "packages/app/.planforge-verify.json", reason: "protected" }
    ]);
    // Near-miss names (no leading dot / prefixed) are not swept in.
    expect(
      evaluateWriteScope(["docs/planforge-verify.json", "src/x.planforge-verify.json"], defaultWriteScopePolicy())
    ).toEqual([]);
  });

  it("allows non-protected source changes by default (no allow-list)", () => {
    expect(evaluateWriteScope(["projects/products/planforge/src/App.tsx"], defaultWriteScopePolicy())).toEqual([]);
  });

  it("protected wins over an allow-list", () => {
    const policy = { protectedGlobs: ["**/*.test.tsx"], allowedGlobs: ["**/*.test.tsx", "src/**"] };
    const v = evaluateWriteScope(["src/App.test.tsx"], policy);
    expect(v).toEqual([{ path: "src/App.test.tsx", reason: "protected" }]);
  });

  it("marks paths outside a non-empty allow-list as not-allowed", () => {
    const policy = { protectedGlobs: [], allowedGlobs: ["src/App.tsx"] };
    expect(evaluateWriteScope(["src/App.tsx"], policy)).toEqual([]);
    expect(evaluateWriteScope(["src/http-server.ts"], policy)).toEqual([
      { path: "src/http-server.ts", reason: "not-allowed" }
    ]);
  });

  it("parses comma/newline glob lists and -z porcelain paths (incl. renames)", () => {
    expect(parseGlobList("a/**, b/*.ts\n c.md")).toEqual(["a/**", "b/*.ts", "c.md"]);
    expect(parseGlobList(undefined)).toEqual([]);
    // -z records are NUL-separated; for a rename the dest comes first then the origin.
    expect(parsePorcelainPaths(" M src/App.tsx\0A  tests/new.test.ts\0R  new.ts\0old.ts\0")).toEqual([
      "src/App.tsx",
      "tests/new.test.ts",
      "new.ts",
      "old.ts"
    ]);
  });

  it("keeps spaced/non-ASCII paths verbatim from the unquoted -z format", () => {
    // porcelain v1 (line format) would C-quote this as "docs/a b/ACCEPTANCE.md"; -z does not.
    expect(parsePorcelainPaths(" M docs/a b/ACCEPTANCE.md\0")).toEqual(["docs/a b/ACCEPTANCE.md"]);
    expect(evaluateWriteScope(parsePorcelainPaths(" M docs/a b/ACCEPTANCE.md\0"), defaultWriteScopePolicy())).toEqual([
      { path: "docs/a b/ACCEPTANCE.md", reason: "protected" }
    ]);
  });

  it("scope-checks the rename ORIGIN, not just the destination", () => {
    // -z rename layout: status, dest path, then origin path (origin AFTER the new name).
    expect(parsePorcelainPaths("R  src/new.ts\0docs/ACCEPTANCE.md\0")).toEqual(["src/new.ts", "docs/ACCEPTANCE.md"]);
    const violations = evaluateWriteScope(
      parsePorcelainPaths("R  src/new.ts\0docs/ACCEPTANCE.md\0"),
      defaultWriteScopePolicy()
    );
    // The destination (src/new.ts) is allowed; the protected origin (docs/ACCEPTANCE.md) is caught.
    expect(violations).toEqual([{ path: "docs/ACCEPTANCE.md", reason: "protected" }]);
  });
});
