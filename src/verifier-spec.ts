import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { JsonValue } from "./shared/json";
import type { VerifierCommand } from "./verifier";

// Per-target verifier spec: a checked-in `.planforge-verify.json` at the TARGET repo root that
// declares what "verified" means for that project, so a non-Node target (Python, Go, docs) is not
// graded by the server-wide `npm test` default. Resolution order per build:
// target spec > env PLANFORGE_VERIFIER_* > built-in default.
//
// Independence: the orchestrator reads the spec from the target repo's own checked-out tree at
// handoff time — never from the build worktree. The worktree is builder-writable, so a spec read
// there would let the builder swap in a vacuous verifier and grade itself. The target's main tree
// is operator-owned within a cycle (the builder writes only in its per-run worktree; merges land
// only after architect sign-off), which is the trust boundary this read relies on.

export const VERIFIER_SPEC_FILENAME = ".planforge-verify.json";
export const MAX_SPEC_VERIFIERS = 8;
// Default per-command verify wall (see OPERATIONS.md) and the hard ceiling a target spec may
// request — a spec cannot grant itself a longer leash than the server default.
export const DEFAULT_VERIFIER_TIMEOUT_MS = 600_000;
// A verifier spec is a handful of names and commands; anything larger is not a spec.
export const MAX_SPEC_BYTES = 16 * 1024;

const verifierSpecSchema = z.strictObject({
  verifiers: z
    .array(z.strictObject({ name: z.string().trim().min(1), command: z.string().trim().min(1) }))
    .min(1)
    .max(MAX_SPEC_VERIFIERS),
  timeoutMs: z.number().int().positive().max(DEFAULT_VERIFIER_TIMEOUT_MS).optional()
});

export type VerifierSpecResolution =
  // A valid spec file: run exactly these commands (spec timeoutMs, when present, wins).
  | { readonly source: "spec"; readonly commands: readonly VerifierCommand[]; readonly timeoutMs?: number }
  // No spec file in the target repo: fall back to the env/default (loop-config) verifiers.
  | { readonly source: "absent" }
  // A spec file exists but is unusable. Fail-closed: the caller must fail the verify with this
  // reason, never silently fall back to the default verifiers.
  | { readonly source: "invalid"; readonly reason: string };

function renderZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`).join("; ");
}

export async function readTargetVerifierSpec(targetRepo: string): Promise<VerifierSpecResolution> {
  const specPath = path.join(targetRepo, VERIFIER_SPEC_FILENAME);
  // Cap on the on-disk size BEFORE reading, so a pathologically large file is never slurped into
  // memory. A spec is a handful of names and commands; anything larger is not a spec.
  try {
    const stats = await stat(specPath);
    if (stats.size > MAX_SPEC_BYTES) {
      return { source: "invalid", reason: `file exceeds ${MAX_SPEC_BYTES} bytes` };
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT" || nodeError.code === "ENOTDIR") {
      return { source: "absent" };
    }
    return { source: "invalid", reason: `unreadable: ${nodeError.message}` };
  }
  let raw: string;
  try {
    raw = await readFile(specPath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT" || nodeError.code === "ENOTDIR") {
      return { source: "absent" };
    }
    // The file exists but cannot be read (permissions, I/O): fail-closed rather than pretending
    // the target has no spec.
    return { source: "invalid", reason: `unreadable: ${nodeError.message}` };
  }
  // Defense-in-depth: re-check after read in case the file grew between stat and read (TOCTOU) or a
  // multibyte encoding makes the byte length exceed the on-disk size cap.
  if (Buffer.byteLength(raw, "utf8") > MAX_SPEC_BYTES) {
    return { source: "invalid", reason: `file exceeds ${MAX_SPEC_BYTES} bytes` };
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch (error) {
    return { source: "invalid", reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = verifierSpecSchema.safeParse(parsed);
  if (!result.success) {
    return { source: "invalid", reason: renderZodIssues(result.error) };
  }
  const { verifiers, timeoutMs } = result.data;
  return { source: "spec", commands: verifiers, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}
