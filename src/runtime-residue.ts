import type { Dirent } from "node:fs";
import { readdir, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";

// Per-run runtime residue lifecycle for a boot-persistent service: the run's .mcp.json is deleted
// at conversation teardown, and runs/<runId> dirs (last-message.txt + events.jsonl) live for a TTL
// window as the ops log, then are swept opportunistically at conversation start. The same sweep
// also reaps runtimeRoot/<runId>/.mcp.json dirs a crash orphaned (teardown never ran to delete them).
export const RUN_RESIDUE_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
// Bounded work per sweep: a conversation start never scans more than this many run dirs.
export const RUN_RESIDUE_SWEEP_LIMIT = 64;

export type SweepRunResidueInput = {
  readonly runtimeRoot: string;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
};

export type SweepRunResidueResult = {
  readonly scanned: number;
  readonly removed: readonly string[];
};

async function mtimeMs(target: string): Promise<number | null> {
  try {
    return (await stat(target)).mtimeMs;
  } catch {
    return null;
  }
}

// A run dir's age is its most recent write: the dir mtime moves on file create/remove, while
// events.jsonl appends move only the file mtime — take the max so an ops log written inside the
// TTL window keeps its run dir alive.
async function lastWriteMs(runDir: string): Promise<number | null> {
  const dirMtime = await mtimeMs(runDir);
  const eventsMtime = await mtimeMs(path.join(runDir, "events.jsonl"));
  const observed = [dirMtime, eventsMtime].filter((value): value is number => value !== null);
  return observed.length === 0 ? null : Math.max(...observed);
}

export async function removeRunMcpConfig(configPath: string): Promise<void> {
  await rm(configPath, { force: true });
  // The config is its run dir's only file; drop the now-empty dir. rmdir refuses a non-empty dir,
  // so anything else living there survives.
  try {
    await rmdir(path.dirname(configPath));
  } catch {
    return;
  }
}

// Run ids are randomUUID(), so a runtimeRoot/<runId> MCP-config dir always matches this shape.
// Anchoring the orphan sweep on it means registered runtime subdirs (runs/, conversations/) and
// anything else living at the runtime root can never be candidates.
const RUN_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MCP_CONFIG_FILENAME = ".mcp.json";

// Conservative removal of a crash-orphaned runtimeRoot/<runId> dir: delete only the expected
// residue file, then rmdir — which refuses a non-empty dir — so anything that appeared inside the
// dir concurrently survives (unlike a recursive rm).
async function removeOrphanedMcpConfigDir(runDir: string): Promise<boolean> {
  await rm(path.join(runDir, MCP_CONFIG_FILENAME), { force: true });
  try {
    await rmdir(runDir);
  } catch {
    return false;
  }
  return true;
}

// A crashed process never runs removeRunMcpConfig, leaving runtimeRoot/<runId>/.mcp.json behind
// forever (sweepRunResidue's main pass only scans runtimeRoot/runs/). Sweep those orphans too, but
// only dirs that (a) match the runId shape, (b) contain nothing but the expected config residue
// (an empty dir counts: a half-finished removeRunMcpConfig leaves one), and (c) are past the TTL.
async function sweepOrphanedMcpConfigDirs(
  runtimeRoot: string,
  ttlMs: number,
  maxEntries: number,
  now: number
): Promise<{ readonly scanned: number; readonly removed: string[] }> {
  if (maxEntries <= 0) {
    return { scanned: 0, removed: [] };
  }
  let entries;
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { scanned: 0, removed: [] };
    }
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && RUN_ID_SHAPE.test(entry.name))
    .slice(0, maxEntries);
  const removed: string[] = [];
  for (const entry of candidates) {
    const runDir = path.join(runtimeRoot, entry.name);
    let contents: string[];
    try {
      contents = await readdir(runDir);
    } catch {
      continue;
    }
    if (contents.some((name) => name !== MCP_CONFIG_FILENAME)) {
      continue;
    }
    const dirMtime = await mtimeMs(runDir);
    const configMtime = await mtimeMs(path.join(runDir, MCP_CONFIG_FILENAME));
    const observed = [dirMtime, configMtime].filter((value): value is number => value !== null);
    const lastWrite = observed.length === 0 ? null : Math.max(...observed);
    if (lastWrite === null || now - lastWrite <= ttlMs) {
      continue;
    }
    if (await removeOrphanedMcpConfigDir(runDir)) {
      removed.push(entry.name);
    }
  }
  return { scanned: candidates.length, removed };
}

export async function sweepRunResidue(input: SweepRunResidueInput): Promise<SweepRunResidueResult> {
  const ttlMs = input.ttlMs ?? RUN_RESIDUE_TTL_MS;
  const maxEntries = input.maxEntries ?? RUN_RESIDUE_SWEEP_LIMIT;
  const now = input.now ? input.now() : Date.now();
  const runsRoot = path.join(input.runtimeRoot, "runs");
  let entries: Dirent[];
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      entries = [];
    } else {
      throw error;
    }
  }
  const candidates = entries.filter((entry) => entry.isDirectory()).slice(0, maxEntries);
  const removed: string[] = [];
  for (const entry of candidates) {
    const runDir = path.join(runsRoot, entry.name);
    const lastWrite = await lastWriteMs(runDir);
    if (lastWrite === null || now - lastWrite <= ttlMs) {
      continue;
    }
    await rm(runDir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  // Crash-orphaned per-run MCP config dirs at the runtime root share the same TTL and the same
  // bounded per-sweep budget (whatever the runs/ pass left unused).
  const orphans = await sweepOrphanedMcpConfigDirs(input.runtimeRoot, ttlMs, maxEntries - candidates.length, now);
  return { scanned: candidates.length + orphans.scanned, removed: [...removed, ...orphans.removed] };
}
