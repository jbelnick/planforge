import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_RESIDUE_TTL_MS, removeRunMcpConfig, sweepRunResidue } from "../src/runtime-residue";

const tempDirs: string[] = [];
const dayMs = 24 * 60 * 60 * 1_000;

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempRuntimeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-runtime-residue-"));
  tempDirs.push(root);
  return root;
}

async function writeRunDir(runtimeRoot: string, runId: string, ageMs: number): Promise<string> {
  const runDir = path.join(runtimeRoot, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "last-message.txt"), "", "utf8");
  await writeFile(path.join(runDir, "events.jsonl"), "", "utf8");
  const stamp = new Date(Date.now() - ageMs);
  await utimes(path.join(runDir, "last-message.txt"), stamp, stamp);
  await utimes(path.join(runDir, "events.jsonl"), stamp, stamp);
  await utimes(runDir, stamp, stamp);
  return runDir;
}

// A crash-orphaned per-run MCP config dir: runtimeRoot/<runId>/.mcp.json left behind because the
// process died before removeRunMcpConfig ran at teardown.
async function writeOrphanedMcpConfigDir(runtimeRoot: string, runId: string, ageMs: number): Promise<string> {
  const runDir = path.join(runtimeRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, ".mcp.json"), "{}\n", "utf8");
  const stamp = new Date(Date.now() - ageMs);
  await utimes(path.join(runDir, ".mcp.json"), stamp, stamp);
  await utimes(runDir, stamp, stamp);
  return runDir;
}

describe("sweepRunResidue", () => {
  it("removes runs dirs older than the TTL and keeps ones still inside the window", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    const stale = await writeRunDir(runtimeRoot, "stale-run", RUN_RESIDUE_TTL_MS + dayMs);
    const fresh = await writeRunDir(runtimeRoot, "fresh-run", dayMs);

    const result = await sweepRunResidue({ runtimeRoot });

    expect(result.removed).toEqual(["stale-run"]);
    expect(existsSync(stale)).toBe(false);
    // Inside the TTL window the run dir — including events.jsonl, the ops log — stays intact.
    expect(existsSync(path.join(fresh, "events.jsonl"))).toBe(true);
  });

  it("keeps an old dir whose events.jsonl was appended inside the TTL window", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    const runDir = await writeRunDir(runtimeRoot, "long-lived-run", RUN_RESIDUE_TTL_MS + dayMs);
    // Appends move only the file mtime, never the dir mtime; the sweep must honor the file.
    const recent = new Date(Date.now() - dayMs);
    await utimes(path.join(runDir, "events.jsonl"), recent, recent);

    const result = await sweepRunResidue({ runtimeRoot });

    expect(result.removed).toEqual([]);
    expect(existsSync(runDir)).toBe(true);
  });

  it("caps the entries scanned per sweep so a conversation start never does unbounded work", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    for (const runId of ["stale-a", "stale-b", "stale-c"]) {
      await writeRunDir(runtimeRoot, runId, RUN_RESIDUE_TTL_MS + dayMs);
    }

    const result = await sweepRunResidue({ runtimeRoot, maxEntries: 2 });

    expect(result.scanned).toBe(2);
    expect(result.removed).toHaveLength(2);
    const survivors = ["stale-a", "stale-b", "stale-c"].filter((runId) =>
      existsSync(path.join(runtimeRoot, "runs", runId))
    );
    expect(survivors).toHaveLength(1);
  });

  it("no-ops when the runs root does not exist yet", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    await expect(sweepRunResidue({ runtimeRoot: path.join(runtimeRoot, "never-created") })).resolves.toEqual({
      scanned: 0,
      removed: []
    });
  });

  it("honors an injected clock and TTL", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    const runDir = await writeRunDir(runtimeRoot, "clocked-run", 2 * dayMs);

    const kept = await sweepRunResidue({ runtimeRoot, ttlMs: 3 * dayMs });
    expect(kept.removed).toEqual([]);

    const removed = await sweepRunResidue({ runtimeRoot, ttlMs: 3 * dayMs, now: () => Date.now() + 2 * dayMs });
    expect(removed.removed).toEqual(["clocked-run"]);
    expect(existsSync(runDir)).toBe(false);
  });

  it("removes a crash-orphaned runtimeRoot/<runId>/.mcp.json dir past the TTL and keeps a fresh one", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    const stale = await writeOrphanedMcpConfigDir(runtimeRoot, "aaaaaaaa-1111-4222-8333-444444444444", RUN_RESIDUE_TTL_MS + dayMs);
    const fresh = await writeOrphanedMcpConfigDir(runtimeRoot, "bbbbbbbb-1111-4222-8333-444444444444", dayMs);

    const result = await sweepRunResidue({ runtimeRoot });

    expect(result.removed).toEqual(["aaaaaaaa-1111-4222-8333-444444444444"]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(path.join(fresh, ".mcp.json"))).toBe(true);
  });

  it("never touches registered runtime subdirs, non-runId names, or dirs with unexpected contents", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    const age = RUN_RESIDUE_TTL_MS + dayMs;
    // runs/ (and anything else not shaped like a randomUUID runId) is not an orphan candidate,
    // no matter how stale.
    const runsDir = await writeRunDir(runtimeRoot, "kept-run", 0);
    const namedDir = await writeOrphanedMcpConfigDir(runtimeRoot, "conversations-like-dir", age);
    // A runId-shaped dir holding more than the expected config residue is left alone entirely.
    const mixedDir = await writeOrphanedMcpConfigDir(runtimeRoot, "cccccccc-1111-4222-8333-444444444444", age);
    await writeFile(path.join(mixedDir, "notes.txt"), "keep me", "utf8");
    const stamp = new Date(Date.now() - age);
    await utimes(mixedDir, stamp, stamp);

    const result = await sweepRunResidue({ runtimeRoot });

    expect(result.removed).toEqual([]);
    expect(existsSync(runsDir)).toBe(true);
    expect(existsSync(path.join(namedDir, ".mcp.json"))).toBe(true);
    expect(existsSync(path.join(mixedDir, ".mcp.json"))).toBe(true);
    expect(existsSync(path.join(mixedDir, "notes.txt"))).toBe(true);
  });

  it("sweeps orphaned config dirs even when the runs root does not exist yet", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    const stale = await writeOrphanedMcpConfigDir(runtimeRoot, "dddddddd-1111-4222-8333-444444444444", RUN_RESIDUE_TTL_MS + dayMs);

    const result = await sweepRunResidue({ runtimeRoot });

    expect(result).toEqual({ scanned: 1, removed: ["dddddddd-1111-4222-8333-444444444444"] });
    expect(existsSync(stale)).toBe(false);
  });

  it("counts orphaned config dirs against the same bounded per-sweep budget", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    await writeRunDir(runtimeRoot, "stale-a", RUN_RESIDUE_TTL_MS + dayMs);
    await writeRunDir(runtimeRoot, "stale-b", RUN_RESIDUE_TTL_MS + dayMs);
    const orphan = await writeOrphanedMcpConfigDir(runtimeRoot, "eeeeeeee-1111-4222-8333-444444444444", RUN_RESIDUE_TTL_MS + dayMs);

    // The runs/ pass consumes the whole budget, so the orphan survives this sweep…
    const capped = await sweepRunResidue({ runtimeRoot, maxEntries: 2 });
    expect(capped.scanned).toBe(2);
    expect(existsSync(orphan)).toBe(true);

    // …and is reaped once budget is available.
    const followUp = await sweepRunResidue({ runtimeRoot, maxEntries: 2 });
    expect(followUp.removed).toContain("eeeeeeee-1111-4222-8333-444444444444");
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("removeRunMcpConfig", () => {
  it("removes the config file and its now-empty run dir", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    const configPath = path.join(runtimeRoot, "run-1", ".mcp.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "{}\n", "utf8");

    await removeRunMcpConfig(configPath);

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(path.dirname(configPath))).toBe(false);
  });

  it("tolerates a missing config and leaves a non-empty dir intact", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    const runDir = path.join(runtimeRoot, "run-2");
    const configPath = path.join(runDir, ".mcp.json");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "other.txt"), "keep me", "utf8");

    await removeRunMcpConfig(configPath);
    await removeRunMcpConfig(configPath);

    expect(existsSync(path.join(runDir, "other.txt"))).toBe(true);
  });
});
