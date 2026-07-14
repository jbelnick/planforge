import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../src/builder/codex-driver";
import { linkNodeModules } from "../src/builder/node-modules-link";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeGit(toplevel: string): GitRunner {
  return async (args) => {
    if (args.includes("rev-parse")) {
      return { stdout: `${toplevel}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

describe("linkNodeModules", () => {
  it("symlinks the target's node_modules into the worktree root when target == git toplevel", async () => {
    const targetRepo = await tempDir("planforge-deps-target-");
    await mkdir(path.join(targetRepo, "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(targetRepo, "node_modules", "left-pad", "index.js"), "module.exports = 0;\n", "utf8");
    const worktreePath = await tempDir("planforge-deps-worktree-");

    const result = await linkNodeModules({ targetRepo, worktreePath, git: fakeGit(targetRepo) });

    expect(result.linked).toBe(true);
    const dest = path.join(worktreePath, "node_modules");
    expect(result.dest).toBe(dest);
    expect((await lstat(dest)).isSymbolicLink()).toBe(true);
    expect(await readlink(dest)).toBe(path.join(targetRepo, "node_modules"));
  });

  it("places the symlink at the target's path relative to the git toplevel for a nested target", async () => {
    const toplevel = await tempDir("planforge-deps-top-");
    const targetRepo = path.join(toplevel, "projects", "products", "planforge");
    await mkdir(path.join(targetRepo, "node_modules"), { recursive: true });
    const worktreePath = await tempDir("planforge-deps-nested-wt-");

    const result = await linkNodeModules({ targetRepo, worktreePath, git: fakeGit(toplevel) });

    expect(result.linked).toBe(true);
    expect(result.dest).toBe(path.join(worktreePath, "projects", "products", "planforge", "node_modules"));
    expect((await lstat(result.dest ?? "")).isSymbolicLink()).toBe(true);
  });

  it("does not overwrite an existing node_modules in the worktree", async () => {
    const targetRepo = await tempDir("planforge-deps-target2-");
    await mkdir(path.join(targetRepo, "node_modules"), { recursive: true });
    const worktreePath = await tempDir("planforge-deps-worktree2-");
    await mkdir(path.join(worktreePath, "node_modules"), { recursive: true });

    const result = await linkNodeModules({ targetRepo, worktreePath, git: fakeGit(targetRepo) });

    expect(result.linked).toBe(false);
    expect(result.reason).toContain("already has node_modules");
    // The existing directory is untouched (still a real directory, not replaced by a symlink).
    expect((await lstat(path.join(worktreePath, "node_modules"))).isDirectory()).toBe(true);
  });

  it("is a no-op when the target repo has no installed node_modules", async () => {
    const targetRepo = await tempDir("planforge-deps-empty-");
    const worktreePath = await tempDir("planforge-deps-worktree3-");

    const result = await linkNodeModules({ targetRepo, worktreePath, git: fakeGit(targetRepo) });

    expect(result.linked).toBe(false);
    expect(result.reason).toContain("no installed node_modules");
  });

  it("with requireIgnored: checks the checkout ignores node_modules, then links", async () => {
    const targetRepo = await tempDir("planforge-deps-req-target-");
    await mkdir(path.join(targetRepo, "node_modules"), { recursive: true });
    const worktreePath = await tempDir("planforge-deps-req-worktree-");
    const gitCalls: string[][] = [];
    const git: GitRunner = async (args) => {
      gitCalls.push([...args]);
      if (args.includes("rev-parse")) {
        return { stdout: `${targetRepo}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" }; // check-ignore success == ignored
    };

    const result = await linkNodeModules({ targetRepo, worktreePath, git, requireIgnored: true });

    expect(result.linked).toBe(true);
    expect(gitCalls).toContainEqual(["-C", worktreePath, "check-ignore", "-q", "--", "node_modules"]);
    expect((await lstat(path.join(worktreePath, "node_modules"))).isSymbolicLink()).toBe(true);
  });

  it("with requireIgnored: falls back without linking when node_modules is not gitignored", async () => {
    const targetRepo = await tempDir("planforge-deps-req-target2-");
    await mkdir(path.join(targetRepo, "node_modules"), { recursive: true });
    const worktreePath = await tempDir("planforge-deps-req-worktree2-");
    const git: GitRunner = async (args) => {
      if (args.includes("rev-parse")) {
        return { stdout: `${targetRepo}\n`, stderr: "" };
      }
      if (args.includes("check-ignore")) {
        throw new Error("exit 1"); // not ignored
      }
      return { stdout: "", stderr: "" };
    };

    const result = await linkNodeModules({ targetRepo, worktreePath, git, requireIgnored: true });

    expect(result.linked).toBe(false);
    expect(result.reason).toContain("not gitignored");
    await expect(lstat(path.join(worktreePath, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("without requireIgnored (verify phase): never runs check-ignore", async () => {
    const targetRepo = await tempDir("planforge-deps-noreq-target-");
    await mkdir(path.join(targetRepo, "node_modules"), { recursive: true });
    const worktreePath = await tempDir("planforge-deps-noreq-worktree-");
    const gitCalls: string[][] = [];
    const git: GitRunner = async (args) => {
      gitCalls.push([...args]);
      if (args.includes("rev-parse")) {
        return { stdout: `${targetRepo}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await linkNodeModules({ targetRepo, worktreePath, git });

    expect(result.linked).toBe(true);
    expect(gitCalls.some((args) => args.includes("check-ignore"))).toBe(false);
  });
});
