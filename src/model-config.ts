import { PlanForgeError } from "./errors";

export const DEFAULT_ARCHITECT_MODELS = ["default", "opus", "sonnet", "haiku"] as const;
export const DEFAULT_BUILDER_MODELS = ["default"] as const;

export type ModelSide = "architect" | "builder";

export function parseModelAllowlist(value: string | undefined, defaults: readonly string[]): readonly string[] {
  const parsed =
    value === undefined || value.trim().length === 0
      ? defaults
      : value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
  const withDefault = parsed.includes("default") ? parsed : ["default", ...parsed];
  return [...new Set(withDefault)];
}

export function parseArchitectModelAllowlist(value: string | undefined): readonly string[] {
  return parseModelAllowlist(value, DEFAULT_ARCHITECT_MODELS);
}

export function parseBuilderModelAllowlist(value: string | undefined): readonly string[] {
  return parseModelAllowlist(value, DEFAULT_BUILDER_MODELS);
}

export function parseModel(side: ModelSide, value: string, allowlist: readonly string[]): string {
  if (allowlist.includes(value)) {
    return value;
  }
  throw new PlanForgeError(
    "E_INVALID_MODEL",
    `${side === "architect" ? "Claude architect" : "Codex builder"} model must be one of: ${allowlist.join(", ")}`
  );
}

export function parseOptionalModel(
  side: ModelSide,
  value: string | undefined,
  allowlist: readonly string[]
): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return parseModel(side, value.trim(), allowlist);
}
