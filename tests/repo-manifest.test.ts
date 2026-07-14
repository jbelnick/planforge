import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepoManifest } from "../src/architect/repo-manifest";
import type { GitRunner } from "../src/builder/codex-driver";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-repo-manifest-"));
  tempDirs.push(root);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
}

function fakeGit(stdout: string): GitRunner {
  return async () => ({ stdout, stderr: "" });
}

describe("repo manifest", () => {
  it("uses a real git repo so ignored files are excluded from the tracked-only manifest", async () => {
    const repo = await tempRoot();
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "PlanForge Manifest Fixture"]);
    await git(repo, ["config", "user.email", "manifest@planforge.local"]);
    await writeFile(path.join(repo, ".gitignore"), "ignored-secret.txt\n", "utf8");
    await writeFile(path.join(repo, "tracked-source.ts"), "export const tracked = true;\n", "utf8");
    await writeFile(path.join(repo, "ignored-secret.txt"), "do not leak\n", "utf8");
    await git(repo, ["add", ".gitignore", "tracked-source.ts"]);
    await git(repo, ["commit", "-m", "tracked baseline"]);

    const manifest = await buildRepoManifest({ targetRepo: repo });

    expect(manifest).toContain("Files (git-tracked):");
    expect(manifest).toContain("tracked-source.ts");
    expect(manifest).not.toContain("ignored-secret.txt");
  });

  it("caps file count with an exact truncation count after dropping the trailing newline", async () => {
    const manifest = await buildRepoManifest({
      targetRepo: "/repo",
      git: fakeGit("a.ts\nb.ts\nc.ts\n"),
      maxFiles: 2
    });

    expect(manifest).toContain("a.ts");
    expect(manifest).toContain("b.ts");
    expect(manifest).not.toContain("c.ts");
    expect(manifest).toContain("(… 1 more files truncated)");
  });

  it("caps key file bytes and marks the key file content truncated", async () => {
    const manifest = await buildRepoManifest({
      targetRepo: "/repo",
      git: fakeGit("README.md\n"),
      readFile: async () => "abcdefghijklmnopqrstuvwxyz",
      maxFileBytes: 18
    });
    const readmeSection = manifest.split("## README.md\n")[1];

    expect(manifest).toContain("(truncated)");
    expect(Buffer.byteLength(readmeSection ?? "", "utf8")).toBeLessThanOrEqual(18);
  });

  it("enforces the total byte cap even when the manifest is truncated", async () => {
    const manifest = await buildRepoManifest({
      targetRepo: "/repo",
      git: fakeGit("README.md\nsrc/a.ts\nsrc/b.ts\nsrc/c.ts\n"),
      readFile: async () => "0123456789".repeat(20),
      maxTotalBytes: 96
    });

    expect(Buffer.byteLength(manifest, "utf8")).toBeLessThanOrEqual(96);
    expect(manifest).toContain("(manifest truncated)");
  });

  it("includes present key files in order and silently skips absent key files", async () => {
    const readPaths: string[] = [];
    const manifest = await buildRepoManifest({
      targetRepo: "/repo",
      git: fakeGit("README.md\npackage.json\nsrc/app.ts\n"),
      readFile: async (filePath) => {
        readPaths.push(filePath);
        return filePath.endsWith("README.md") ? "# Repo\n" : "{\"type\":\"module\"}\n";
      }
    });

    expect(manifest).toContain("Key files:");
    expect(manifest.indexOf("## README.md")).toBeLessThan(manifest.indexOf("## package.json"));
    expect(manifest).not.toContain("## AGENTS.md");
    expect(readPaths).toEqual([path.join("/repo", "README.md"), path.join("/repo", "package.json")]);
  });

  it("returns an empty manifest when git ls-files rejects", async () => {
    const manifest = await buildRepoManifest({
      targetRepo: "/repo",
      git: async () => {
        throw new Error("not a git repo");
      }
    });

    expect(manifest).toBe("");
  });

  it("skips an unreadable key file and still builds the manifest from available context", async () => {
    const manifest = await buildRepoManifest({
      targetRepo: "/repo",
      git: fakeGit("README.md\npackage.json\nsrc/app.ts\n"),
      readFile: async (filePath) => {
        if (filePath.endsWith("README.md")) {
          throw new Error("read failed");
        }
        return "{\"type\":\"module\"}\n";
      }
    });

    // The unreadable README is degraded out, but the tracked-file list and the readable
    // package.json key file still make it into the manifest.
    expect(manifest).toContain("Files (git-tracked):");
    expect(manifest).toContain("src/app.ts");
    expect(manifest).toContain("## package.json");
    expect(manifest).not.toContain("## README.md");
  });
});
