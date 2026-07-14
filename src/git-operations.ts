import { createDefaultGitRunner, removeCodexWorktree, type GitRunner } from "./builder/codex-driver";

const defaultGit = createDefaultGitRunner();
const PATCH_LIMIT_BYTES = 64 * 1024;
const TRUNCATED_MARKER = "\n…truncated";

export async function mergeFastForward(input: {
  readonly targetRepo: string;
  readonly branch: string;
  readonly git?: GitRunner;
}): Promise<void> {
  // Disable any target-repo merge hooks so a malicious or broken hook can't execute arbitrary
  // code during the fast-forward merge.
  await (input.git ?? defaultGit)([
    "-C",
    input.targetRepo,
    "-c",
    "core.hooksPath=/dev/null",
    "merge",
    "--ff-only",
    input.branch
  ]);
}

export async function removeBuilderWorktree(input: {
  readonly targetRepo: string;
  readonly worktreePath: string;
  readonly git?: GitRunner;
}): Promise<void> {
  await removeCodexWorktree({
    targetRepo: input.targetRepo,
    worktreePath: input.worktreePath,
    git: input.git ?? defaultGit
  });
}

function capPatch(patch: string): { readonly patch: string; readonly truncated: boolean } {
  const bytes = Buffer.byteLength(patch, "utf8");
  if (bytes <= PATCH_LIMIT_BYTES) {
    return { patch, truncated: false };
  }
  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER, "utf8");
  const buffer = Buffer.from(patch, "utf8").subarray(0, Math.max(0, PATCH_LIMIT_BYTES - markerBytes));
  return { patch: buffer.toString("utf8") + TRUNCATED_MARKER, truncated: true };
}

export async function buildChangeDiff(input: {
  readonly targetRepo: string;
  readonly base: string;
  readonly head: string;
  readonly git?: GitRunner;
}): Promise<{ readonly stat: string; readonly patch: string; readonly truncated: boolean }> {
  const git = input.git ?? defaultGit;
  const range = `${input.base}..${input.head}`;
  const stat = (await git(["-C", input.targetRepo, "diff", range, "--stat"])).stdout;
  const rawPatch = (await git(["-C", input.targetRepo, "diff", range, "--patch"])).stdout;
  const capped = capPatch(rawPatch);
  return {
    stat,
    patch: capped.patch,
    truncated: capped.truncated
  };
}
