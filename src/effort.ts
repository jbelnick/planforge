import { PlanForgeError } from "./errors";

export const ARCHITECT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const BUILDER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ArchitectEffort = (typeof ARCHITECT_EFFORTS)[number];
export type BuilderEffort = (typeof BUILDER_EFFORTS)[number];

function parseEffort<const Efforts extends readonly string[]>(
  cliName: string,
  allowed: Efforts,
  value: string
): Efforts[number] {
  if (allowed.includes(value)) {
    return value;
  }
  throw new PlanForgeError("E_INVALID_EFFORT", `${cliName} effort must be one of: ${allowed.join(", ")}`);
}

export function parseArchitectEffort(value: string): ArchitectEffort {
  return parseEffort("Claude architect", ARCHITECT_EFFORTS, value);
}

export function parseBuilderEffort(value: string): BuilderEffort {
  return parseEffort("Codex builder", BUILDER_EFFORTS, value);
}

export function parseOptionalEffort<Effort extends string>(
  value: string | undefined,
  parser: (value: string) => Effort
): Effort | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return parser(value);
}

export function parseOptionalArchitectEffort(value: string | undefined): ArchitectEffort | undefined {
  return parseOptionalEffort(value, parseArchitectEffort);
}

export function parseOptionalBuilderEffort(value: string | undefined): BuilderEffort | undefined {
  return parseOptionalEffort(value, parseBuilderEffort);
}
