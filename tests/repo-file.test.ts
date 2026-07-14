import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readRepoFile } from "../src/architect/repo-file";
import type { GitRunner } from "../src/builder/codex-driver";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-repo-file-"));
  tempDirs.push(root);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
}

function fakeGit(stdout: string): GitRunner {
  return async () => ({ stdout, stderr: "" });
}

async function createRepoFixture(): Promise<{ readonly repo: string; readonly outsideFile: string }> {
  const root = await tempRoot();
  const repo = path.join(root, "repo");
  const outsideFile = path.join(root, "outside-secret.txt");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tracked-dir"), { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "PlanForge Repo File Fixture"]);
  await git(repo, ["config", "user.email", "repo-file@planforge.local"]);
  await writeFile(path.join(repo, ".gitignore"), "ignored-secret.txt\n", "utf8");
  await writeFile(path.join(repo, "src", "tracked.txt"), "tracked content\n", "utf8");
  await writeFile(path.join(repo, "tracked-dir", "child.txt"), "child\n", "utf8");
  await writeFile(path.join(repo, "ignored-secret.txt"), "ignored\n", "utf8");
  await writeFile(path.join(repo, "untracked.txt"), "untracked\n", "utf8");
  await writeFile(outsideFile, "outside\n", "utf8");
  await symlink(outsideFile, path.join(repo, "outside-link"));
  await git(repo, ["add", ".gitignore", "src/tracked.txt", "tracked-dir/child.txt", "outside-link"]);
  await git(repo, ["commit", "-m", "repo file fixture"]);
  return { repo, outsideFile };
}

describe("repo file reader", () => {
  it("returns a tracked regular file without truncation", async () => {
    const { repo } = await createRepoFixture();

    await expect(readRepoFile({ targetRepo: repo, requestPath: "src/tracked.txt" })).resolves.toEqual({
      path: "src/tracked.txt",
      content: "tracked content\n",
      truncated: false
    });
  });

  it("rejects gitignored and untracked on-disk files", async () => {
    const { repo } = await createRepoFixture();

    for (const requestPath of ["ignored-secret.txt", "untracked.txt"]) {
      await expect(readRepoFile({ targetRepo: repo, requestPath })).rejects.toMatchObject({
        name: "PlanForgeError",
        code: "E_FILE_NOT_TRACKED"
      });
    }
  });

  it("rejects traversal, absolute paths, and tracked symlink escapes", async () => {
    const { repo, outsideFile } = await createRepoFixture();

    for (const requestPath of [`../${path.basename(outsideFile)}`, outsideFile, "outside-link"]) {
      await expect(readRepoFile({ targetRepo: repo, requestPath })).rejects.toMatchObject({
        name: "PlanForgeError",
        code: "E_PATH_OUTSIDE_REPO"
      });
    }
  });

  it("truncates oversized tracked content without splitting UTF-8 characters", async () => {
    const root = await tempRoot();
    const repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "big.txt"), "placeholder\n", "utf8");

    const result = await readRepoFile({
      targetRepo: repo,
      requestPath: "big.txt",
      git: fakeGit("big.txt\n"),
      readFile: async () => "alpha😀beta".repeat(10),
      maxBytes: 20
    });

    expect(result.path).toBe("big.txt");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(20);
    expect(result.content).toContain("(truncated)");
    expect(result.content).not.toContain("\uFFFD");
  });

  it("rejects a tracked directory as a PlanForgeError instead of leaking EISDIR", async () => {
    const { repo } = await createRepoFixture();

    await expect(readRepoFile({ targetRepo: repo, requestPath: "tracked-dir" })).rejects.toMatchObject({
      name: "PlanForgeError",
      code: "E_FILE_NOT_TRACKED"
    });
  });
});
