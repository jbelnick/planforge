import { readFile as nodeReadFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createDefaultGitRunner, type GitRunner } from "../builder/codex-driver";
import { PlanForgeError } from "../errors";
import { containsPath } from "../shared/paths";
import { byteLength, normalizeCap, truncateWithMarker, TRUNCATED_MARKER } from "../shared/text";

const DEFAULT_MAX_BYTES = 65_536;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export type ReadRepoFileInput = {
  readonly targetRepo: string;
  readonly requestPath: string;
  readonly git?: GitRunner;
  readonly readFile?: (filePath: string) => Promise<string>;
  readonly maxBytes?: number;
};

export type ReadRepoFileResult = {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
};

const defaultGit = createDefaultGitRunner({ maxBufferBytes: GIT_MAX_BUFFER_BYTES });

async function realpathRequestPath(targetRepo: string, requestPath: string): Promise<string> {
  try {
    return await realpath(path.resolve(targetRepo, requestPath));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new PlanForgeError("E_FILE_NOT_TRACKED", `File ${requestPath} is not git-tracked in the target repo.`);
    }
    throw new PlanForgeError("E_FILE_NOT_TRACKED", `File ${requestPath} could not be resolved in the target repo.`);
  }
}

async function realpathTargetRepo(targetRepo: string): Promise<string> {
  try {
    return await realpath(targetRepo);
  } catch {
    throw new PlanForgeError("E_FILE_NOT_TRACKED", "Target repo could not be resolved.");
  }
}

async function assertGitTracked(input: {
  readonly git: GitRunner;
  readonly targetRepo: string;
  readonly requestPath: string;
}): Promise<void> {
  let result: { readonly stdout: string };
  try {
    result = await input.git(["-C", input.targetRepo, "ls-files", "--", input.requestPath]);
  } catch {
    throw new PlanForgeError("E_FILE_NOT_TRACKED", `File ${input.requestPath} is not git-tracked in the target repo.`);
  }
  if (result.stdout.trim() === "") {
    throw new PlanForgeError("E_FILE_NOT_TRACKED", `File ${input.requestPath} is not git-tracked in the target repo.`);
  }
}

async function assertRegularFile(absPath: string, requestPath: string): Promise<void> {
  try {
    const stats = await stat(absPath);
    if (!stats.isFile()) {
      throw new PlanForgeError("E_FILE_NOT_TRACKED", `File ${requestPath} is not a regular git-tracked file.`);
    }
  } catch (error) {
    if (error instanceof PlanForgeError) {
      throw error;
    }
    throw new PlanForgeError("E_FILE_NOT_TRACKED", `File ${requestPath} is not a regular git-tracked file.`);
  }
}

export async function readRepoFile(input: ReadRepoFileInput): Promise<ReadRepoFileResult> {
  const git = input.git ?? defaultGit;
  const readFile = input.readFile ?? ((filePath: string) => nodeReadFile(filePath, "utf8"));
  const maxBytes = normalizeCap(input.maxBytes, DEFAULT_MAX_BYTES);

  const repoReal = await realpathTargetRepo(input.targetRepo);
  const abs = await realpathRequestPath(input.targetRepo, input.requestPath);
  if (!containsPath(repoReal, abs)) {
    throw new PlanForgeError("E_PATH_OUTSIDE_REPO", `File ${input.requestPath} is outside the target repo.`);
  }

  await assertGitTracked({ git, targetRepo: input.targetRepo, requestPath: input.requestPath });
  await assertRegularFile(abs, input.requestPath);

  let rawContent: string;
  try {
    rawContent = await readFile(abs);
  } catch {
    throw new PlanForgeError("E_FILE_NOT_TRACKED", `File ${input.requestPath} could not be read from the target repo.`);
  }
  const truncated = byteLength(rawContent) > maxBytes;
  return {
    path: input.requestPath,
    content: truncateWithMarker(rawContent, maxBytes, TRUNCATED_MARKER),
    truncated
  };
}
