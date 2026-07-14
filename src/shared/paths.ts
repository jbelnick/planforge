import path from "node:path";

// SECURITY-LOAD-BEARING containment check shared by the target allowlist, repo-file reads, and
// static serving. Both paths must already be resolved (realpath'd) by the caller; a symlinked
// child that resolves outside the parent must be resolved before this check.
export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
