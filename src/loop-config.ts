import type { WriteScopePolicy } from "./builder/write-scope";
import type { ArchitectEffort, BuilderEffort } from "./effort";
import type { VerifierCommand } from "./verifier";

export type PlanForgeLoopConfig = {
  readonly targetRepo: string;
  readonly runtimeRoot: string;
  readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly verifierCommands: readonly VerifierCommand[];
  readonly architectEffort?: ArchitectEffort;
  readonly builderEffort?: BuilderEffort;
  readonly architectModels?: readonly string[];
  readonly builderModels?: readonly string[];
  readonly writeScopePolicy?: WriteScopePolicy;
  readonly verifierTimeoutMs?: number;
  readonly architectModel?: string;
  readonly builderModel?: string;
  readonly notifyCommand?: string;
  readonly publicUrl?: string;
};
