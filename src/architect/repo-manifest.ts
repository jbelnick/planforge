import { readFile as nodeReadFile } from "node:fs/promises";
import path from "node:path";
import { createDefaultGitRunner, type GitRunner } from "../builder/codex-driver";
import { normalizeCap, truncateWithMarker, TRUNCATED_MARKER } from "../shared/text";

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 4096;
const DEFAULT_MAX_TOTAL_BYTES = 24_576;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const KEY_FILES = ["README.md", "AGENTS.md", "package.json"] as const;
const MANIFEST_TRUNCATED_MARKER = "\n(manifest truncated)";

export type BuildRepoManifestInput = {
  readonly targetRepo: string;
  readonly git?: GitRunner;
  readonly readFile?: (filePath: string) => Promise<string>;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
};

const defaultGit = createDefaultGitRunner({ maxBufferBytes: GIT_MAX_BUFFER_BYTES });

export async function buildRepoManifest(input: BuildRepoManifestInput): Promise<string> {
  const git = input.git ?? defaultGit;
  const readFile = input.readFile ?? ((filePath: string) => nodeReadFile(filePath, "utf8"));
  const maxFiles = normalizeCap(input.maxFiles, DEFAULT_MAX_FILES);
  const maxFileBytes = normalizeCap(input.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = normalizeCap(input.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);

  let trackedFiles: readonly string[];
  try {
    const result = await git(["-C", input.targetRepo, "ls-files"]);
    trackedFiles = result.stdout.split("\n").filter(Boolean);
  } catch {
    return "";
  }

  const trackedSet = new Set(trackedFiles);
  const manifestLines: string[] = ["Files (git-tracked):"];
  for (const filePath of trackedFiles.slice(0, maxFiles)) {
    manifestLines.push(filePath);
  }
  const truncatedFileCount = trackedFiles.length - maxFiles;
  if (truncatedFileCount > 0) {
    manifestLines.push(`(… ${truncatedFileCount} more files truncated)`);
  }

  const keyFileSections: string[] = [];
  for (const keyFile of KEY_FILES) {
    if (!trackedSet.has(keyFile)) {
      continue;
    }
    let contents: string;
    try {
      contents = await readFile(path.join(input.targetRepo, keyFile));
    } catch {
      // Degrade like the ls-files failure above: an unreadable key file is skipped, not fatal, so
      // the manifest is still built with whatever context is available.
      continue;
    }
    keyFileSections.push(`## ${keyFile}\n${truncateWithMarker(contents, maxFileBytes, TRUNCATED_MARKER)}`);
  }

  if (keyFileSections.length > 0) {
    manifestLines.push("", "Key files:", ...keyFileSections);
  }

  return truncateWithMarker(manifestLines.join("\n"), maxTotalBytes, MANIFEST_TRUNCATED_MARKER);
}
