import { lstat, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import type { GitRunner } from "./codex-driver";

export type LinkNodeModulesInput = {
  readonly targetRepo: string;
  readonly worktreePath: string;
  readonly git: GitRunner;
  // Build-phase safety: only link when the checkout gitignores the dest. The build worktree is
  // linked BEFORE the post-build `git add -A`, so a target that did not ignore node_modules would
  // otherwise get the symlink staged into the build commit (and merged on sign-off). Verify links
  // after the commit and skips this check.
  readonly requireIgnored?: boolean;
};

export type LinkNodeModulesResult = {
  readonly linked: boolean;
  readonly dest?: string;
  readonly reason?: string;
};

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

// Symlink the target repo's installed node_modules into the matching path inside a run's build
// worktree so neither phase pays a full `npm ci` in a fresh checkout — the heaviest, most
// network-fragile part of a cycle. Two call sites, both in run-builder:
//   - build: AFTER the worktree is created and BEFORE codex spawns, so the builder's wall budget
//     is not burned on a cold install (requireIgnored keeps the pre-commit symlink out of the
//     post-build `git add -A`);
//   - verify: after the builder has committed and before the verifier runs (usually a no-op now —
//     the build-phase link is still in place — but it self-heals a worktree the builder stripped).
// The worktree is removed with `git worktree remove --force`, which unlinks the symlink without
// touching the real node_modules. Best-effort: any failure leaves the worktree without
// node_modules so the phase's own install fallback runs. The dest sits at
// <worktreePath>/<targetRepo-relative-to-git-toplevel>. A PlanForge target is its OWN standalone
// repo (enforced by the target allowlist), so the toplevel is the target itself and the relative
// segment is empty — the dest is <worktreePath>/node_modules and both phases run from the worktree
// root. The relative-segment logic (and the escape check below) stays as a defense-in-depth
// generalization; it just resolves to "" for a standalone target.
export async function linkNodeModules(input: LinkNodeModulesInput): Promise<LinkNodeModulesResult> {
  const source = path.join(input.targetRepo, "node_modules");
  if (!(await exists(source))) {
    return { linked: false, reason: "target repo has no installed node_modules to reuse" };
  }

  let rel = "";
  try {
    const { stdout } = await input.git(["-C", input.targetRepo, "rev-parse", "--show-toplevel"]);
    const toplevel = path.resolve(stdout.trim());
    rel = path.relative(toplevel, path.resolve(input.targetRepo));
  } catch (error) {
    return { linked: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { linked: false, reason: "target repo resolved outside its git toplevel" };
  }

  const dest = path.join(input.worktreePath, rel, "node_modules");
  if (await exists(dest)) {
    return { linked: false, dest, reason: "worktree already has node_modules" };
  }

  if (input.requireIgnored) {
    try {
      // check-ignore exits 0 only when the path is ignored; any other exit fails the safety check
      // closed and the phase falls back to its own install.
      await input.git(["-C", input.worktreePath, "check-ignore", "-q", "--", path.join(rel, "node_modules")]);
    } catch {
      return {
        linked: false,
        dest,
        reason: "node_modules is not gitignored in the target checkout, so a pre-commit link would be staged by the build commit"
      };
    }
  }

  try {
    await mkdir(path.dirname(dest), { recursive: true });
    await symlink(source, dest, "dir");
    return { linked: true, dest };
  } catch (error) {
    return { linked: false, dest, reason: error instanceof Error ? error.message : String(error) };
  }
}
