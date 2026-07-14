import { z } from "zod";
import type { WriteScopePolicy } from "./builder/write-scope";
import { readRepoFile } from "./architect/repo-file";
import type { ArchitectEffort, BuilderEffort } from "./effort";
import { PlanForgeError } from "./errors";
import type { ChatRun, ChatRunService, JsonValue } from "./run-service";
import type { PlanForgeRegistry } from "./registry";

const nonEmptyString = z.string().min(1);

export const verifierStatusSchema = z.enum(["pass", "fail", "blocked"]);

export const verifierResultSchema = z.object({
  name: nonEmptyString,
  status: verifierStatusSchema,
  exitCode: z.number().int().nullable().optional(),
  output: z.string().optional()
});

export const proposePlanInputSchema = z.object({
  runId: nonEmptyString,
  title: nonEmptyString,
  plan: nonEmptyString
});

export const approvalInputSchema = z.object({
  verdict: z.enum(["approved", "changes_requested"]),
  reviewer: z.string().min(1).optional(),
  feedback: z.string().min(1).optional()
});

export const handoffToCodexInputSchema = z.object({
  runId: nonEmptyString,
  project: nonEmptyString,
  objective: nonEmptyString,
  context: z.string(),
  constraints: z.string(),
  verification: z.array(nonEmptyString),
  stop_conditions: z.array(nonEmptyString)
});

export const handoffToCodexOutputSchema = z.object({
  status: verifierStatusSchema,
  verifierResults: z.array(verifierResultSchema)
});

export const signOffInputSchema = z.object({
  runId: nonEmptyString,
  verdict: z.literal("pass"),
  grade: nonEmptyString,
  acknowledgeTestChanges: z.boolean().optional()
});

export const readRepoFileInputSchema = z.object({
  runId: nonEmptyString,
  path: nonEmptyString
});

export type PlanForgeToolLoopConfig = {
  readonly targetRepo: string;
  readonly runtimeRoot: string;
  readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly verifierCommands: readonly { readonly name: string; readonly command: string }[];
  readonly writeScopePolicy?: WriteScopePolicy;
  readonly verifierTimeoutMs?: number;
  readonly architectEffort?: ArchitectEffort;
  readonly builderEffort?: BuilderEffort;
  readonly architectModels?: readonly string[];
  readonly builderModels?: readonly string[];
  // Optional model identity per side, surfaced in the usage showcase when configured. The architect
  // model is also reported live by the architect CLI (latched from its status line); the builder
  // model is not reported by Codex, so it is only known when explicitly configured here.
  readonly architectModel?: string;
  readonly builderModel?: string;
};

export type PlanForgeToolHandlerInput = {
  readonly registry: PlanForgeRegistry;
  readonly runService?: ChatRunService;
  readonly loopConfig?: PlanForgeToolLoopConfig;
  // Per-run target override (runId -> resolved targetRepo), shared with the orchestrator so the
  // read_repo_file MCP tool reads from THIS conversation's target when one is set.
  readonly targetRepoStore?: Map<string, string>;
};

function parseToolInput<T>(schema: z.ZodType<T>, toolName: string, input: JsonValue): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid ${toolName} input: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

function resolveRun(input: PlanForgeToolHandlerInput, runId: string): ChatRun | null {
  if (!input.runService) {
    return null;
  }
  const run = input.runService.get(runId);
  if (!run) {
    throw new PlanForgeError("E_RUN_NOT_FOUND", `Run ${runId} was not found.`);
  }
  return run;
}

export function createPlanForgeToolHandlers(input: PlanForgeToolHandlerInput) {
  const registry = input.registry;
  return {
    async propose_plan(raw: JsonValue) {
      const proposal = parseToolInput(proposePlanInputSchema, "propose_plan", raw);
      const run = resolveRun(input, proposal.runId);
      const approval = registry.proposePlan(proposal);
      if (run && input.runService) {
        input.runService.emit(run, "plan_proposed", proposal);
      }
      return approval;
    },
    async handoff_to_codex(raw: JsonValue) {
      const handoff = parseToolInput(handoffToCodexInputSchema, "handoff_to_codex", raw);
      resolveRun(input, handoff.runId);
      return registry.handoffToCodex(handoff);
    },
    async sign_off(raw: JsonValue) {
      const signOff = parseToolInput(signOffInputSchema, "sign_off", raw);
      const run = resolveRun(input, signOff.runId);
      const result = registry.signOff(signOff);
      if (run && input.runService) {
        // Record whether the architect acknowledged weakened test coverage on both the grade and the
        // sign_off event, so the transcript preserves an audited decision (the gate only lets a
        // weakened build through when this was consciously true — see registry.signOff).
        const acknowledgeTestChanges = signOff.acknowledgeTestChanges === true;
        input.runService.emit(run, "architect_grade", {
          runId: signOff.runId,
          verdict: signOff.verdict,
          grade: signOff.grade,
          acknowledgeTestChanges
        });
        input.runService.emit(run, "sign_off", { runId: signOff.runId, verdict: signOff.verdict, acknowledgeTestChanges });
      }
      return result;
    },
    async read_repo_file(raw: JsonValue) {
      const readRequest = parseToolInput(readRepoFileInputSchema, "read_repo_file", raw);
      resolveRun(input, readRequest.runId);
      if (!input.loopConfig) {
        throw new PlanForgeError("E_LOOP_CONFIG_MISSING", "PlanForge loop config is required to read target repo files.");
      }
      // Read from THIS conversation's target when one is set (per-run override), else the default.
      const targetRepo = input.targetRepoStore?.get(readRequest.runId) ?? input.loopConfig.targetRepo;
      return readRepoFile({
        targetRepo,
        requestPath: readRequest.path
      });
    }
  };
}

export type PlanForgeToolHandlers = ReturnType<typeof createPlanForgeToolHandlers>;
