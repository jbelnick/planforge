import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { PlanForgeError } from "./errors";
import { containsPath } from "./shared/paths";

const allowedBuckets = ["agent-workflows", "platform", "products", "research"] as const;

export type AssertAllowedTargetRepoInput = {
  readonly targetRepo: string;
  readonly workspaceRoot?: string;
  // Injectable for tests, like the lister's.
  readonly isGitRepo?: (projectDir: string) => boolean;
};

export type ListAllowedTargetReposInput = {
  readonly workspaceRoot?: string;
  // Injectable for tests so the lister does not touch the real filesystem.
  readonly readBucket?: (bucketDir: string) => readonly string[];
  readonly isGitRepo?: (projectDir: string) => boolean;
};

export type AllowedTarget = {
  // Absolute, realpath-resolved path — the value to pass as PLANFORGE_TARGET_REPO.
  readonly path: string;
  // A short label for the UI picker: "<bucket>/<project>".
  readonly label: string;
};

function realpathOrThrow(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new PlanForgeError("E_TARGET_NOT_FOUND", `Target repo does not exist: ${filePath}`);
    }
    throw error;
  }
}

function defaultWorkspaceRoot(): string {
  return path.resolve(process.cwd(), "../../..");
}

function defaultReadBucket(bucketDir: string): readonly string[] {
  try {
    return readdirSync(bucketDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// The gitdir line in a `.git` FILE (worktree/submodule pointer), e.g. `gitdir: /path/to/.git`.
function parseGitdirPointer(contents: string): string | undefined {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
  const target = match?.[1];
  return target && target.length > 0 ? target : undefined;
}

function defaultIsGitRepo(projectDir: string): boolean {
  // A build target must be its own worktree-able git repo whose `.git` cannot be steered to open the
  // ENCLOSING repo. `lstat` (never `stat`) so a symlinked `.git` — `.git -> ../../.git`, which would
  // re-open the estate umbrella — is seen as a symlink and rejected. Accept only a real `.git`
  // DIRECTORY, or a real `.git` FILE whose `gitdir:` resolves to a path INSIDE the realpath'd target
  // (a normal in-tree worktree/submodule); a gitdir that escapes the target (a crafted
  // `gitdir: <umbrella>/.git`) is rejected. Best-effort: missing/unreadable means "not a repo".
  try {
    const gitEntryPath = path.join(projectDir, ".git");
    const gitEntry = lstatSync(gitEntryPath);
    if (gitEntry.isSymbolicLink()) {
      return false;
    }
    if (gitEntry.isDirectory()) {
      return true;
    }
    if (!gitEntry.isFile()) {
      return false;
    }
    const gitdir = parseGitdirPointer(readFileSync(gitEntryPath, "utf8"));
    if (gitdir === undefined) {
      return false;
    }
    const resolvedTarget = realpathSync(projectDir);
    const resolvedGitdir = realpathSync(path.resolve(resolvedTarget, gitdir));
    return containsPath(resolvedTarget, resolvedGitdir);
  } catch {
    return false;
  }
}

export function assertAllowedTargetRepo(input: AssertAllowedTargetRepoInput): void {
  const workspaceRoot = realpathOrThrow(input.workspaceRoot ?? defaultWorkspaceRoot());
  const targetRepo = realpathOrThrow(input.targetRepo);
  const deniedRoots = [
    path.join(workspaceRoot, ".hermes"),
    path.join(workspaceRoot, "shared-runtime")
  ].map((deniedRoot) => {
    try {
      return realpathSync(deniedRoot);
    } catch {
      return deniedRoot;
    }
  });

  if (deniedRoots.some((deniedRoot) => containsPath(deniedRoot, targetRepo))) {
    throw new PlanForgeError("E_TARGET_NOT_ALLOWLISTED", `Target repo is outside the PlanForge allowlist: ${input.targetRepo}`);
  }

  const allowedRoots = allowedBuckets.map((bucket) => path.join(workspaceRoot, "projects", bucket)).map((allowedRoot) => {
    try {
      return realpathSync(allowedRoot);
    } catch {
      return allowedRoot;
    }
  });
  if (allowedRoots.some((allowedRoot) => containsPath(allowedRoot, targetRepo))) {
    const isGitRepo = input.isGitRepo ?? defaultIsGitRepo;
    if (isGitRepo(targetRepo)) {
      return;
    }
    throw new PlanForgeError(
      "E_TARGET_NOT_ALLOWLISTED",
      `Target repo is not a standalone git repo (no .git at its root): ${input.targetRepo}. ` +
        "PlanForge targets must be their own git repos — worktree/branch/merge operations on a tracked " +
        "subdirectory would act on the enclosing repo instead."
    );
  }

  throw new PlanForgeError("E_TARGET_NOT_ALLOWLISTED", `Target repo is outside the PlanForge allowlist: ${input.targetRepo}`);
}

// Enumerate the allowlisted build targets: every `projects/<bucket>/<project>` directory that is a
// git repo. Returns realpath-resolved absolute paths (the value PLANFORGE_TARGET_REPO takes) plus a
// "<bucket>/<project>" label for the UI picker. Mirrors assertAllowedTargetRepo's requirements
// (bucket containment + own .git) so a listed target always passes the assertion, and the assertion
// enforces the same own-repo rule for targets that never went through the picker. Missing buckets
// are skipped (an empty estate still resolves to an empty list, never an error).
export function listAllowedTargetRepos(input: ListAllowedTargetReposInput = {}): readonly AllowedTarget[] {
  const workspaceRoot = input.workspaceRoot ?? defaultWorkspaceRoot();
  const readBucket = input.readBucket ?? defaultReadBucket;
  const isGitRepo = input.isGitRepo ?? defaultIsGitRepo;
  const targets: AllowedTarget[] = [];
  for (const bucket of allowedBuckets) {
    const bucketDir = path.join(workspaceRoot, "projects", bucket);
    for (const projectName of readBucket(bucketDir)) {
      const projectDir = path.join(bucketDir, projectName);
      if (!isGitRepo(projectDir)) {
        continue;
      }
      try {
        const resolved = realpathSync(projectDir);
        targets.push({ path: resolved, label: `${bucket}/${projectName}` });
      } catch {
        // A broken symlink / unreadable dir is skipped, not fatal.
      }
    }
  }
  return targets;
}
