import { createServer, type RequestListener, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePlanForgeMcpConfig } from "./architect/mcp-config";
import { DEFAULT_PLANFORGE_PORT, PLANFORGE_HOST } from "./config";
import {
  createConversationOrchestrator,
  type ArchitectSessionStarter,
  type ClearTimer,
  type ConversationOrchestrator,
  type McpSessionStore,
  type SetTimer,
  type WriteMcpConfig
} from "./conversation-orchestrator";
import { DEFAULT_PROTECTED_GLOBS, parseGlobList, type WriteScopePolicy } from "./builder/write-scope";
import { createConversationStore, type ConversationStore } from "./conversation-store";
import { parseOptionalArchitectEffort, parseOptionalBuilderEffort, type ArchitectEffort, type BuilderEffort } from "./effort";
import { PlanForgeError } from "./errors";
import type { PlanForgeLoopConfig } from "./loop-config";
import { parseArchitectModelAllowlist, parseBuilderModelAllowlist, parseOptionalModel } from "./model-config";
import { createNotifyHook } from "./notify-hook";
import { createChatRunService, type ChatRunService } from "./run-service";
import { createPlanForgeRegistry, type PlanForgeRegistry } from "./registry";
import { createPlanForgeRunBuilder } from "./run-builder";
import { createPlanForgeSingleProcessHandler } from "./server";
import { assertAllowedTargetRepo } from "./target-allowlist";
import type { VerifierCommand, VerifierCommandRunner } from "./verifier";
// DEFAULT_VERIFIER_TIMEOUT_MS also caps the timeoutMs a target's .planforge-verify.json may request.
import { DEFAULT_VERIFIER_TIMEOUT_MS } from "./verifier-spec";
import type { CodexRunner, GitRunner } from "./builder/codex-driver";

export type { PlanForgeLoopConfig } from "./loop-config";

// Server-wide fallbacks, used only when the target repo has no checked-in .planforge-verify.json.
// Per-build resolution order: target spec > env PLANFORGE_VERIFIER_* > these defaults.
const DEFAULT_VERIFIER_NAME = "planforge tests";
const DEFAULT_VERIFIER_COMMAND = "npm test";

export type CreatePlanForgeServerInput = {
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly cwd?: string;
  readonly workspaceRoot?: string;
  readonly host?: string;
  readonly port?: number;
  readonly registry?: PlanForgeRegistry;
  readonly runService?: ChatRunService;
  readonly codexRunner?: CodexRunner;
  readonly git?: GitRunner;
  readonly verifierRunner?: VerifierCommandRunner;
  readonly loopConfig?: PlanForgeLoopConfig;
  readonly conversationStore?: ConversationStore;
  readonly startSession?: ArchitectSessionStarter;
  readonly writeMcpConfig?: WriteMcpConfig;
  readonly idleTimeoutMs?: number;
  readonly setTimer?: SetTimer;
  readonly clearTimer?: ClearTimer;
  readonly staticRoot?: string;
};

export type PlanForgeServerParts = {
  readonly host: string;
  readonly port: number;
  readonly registry: PlanForgeRegistry;
  readonly runService: ChatRunService;
  readonly loopConfig: PlanForgeLoopConfig;
  readonly conversationStore: ConversationStore;
  readonly conversationOrchestrator: ConversationOrchestrator;
  readonly resolvedPort: () => number;
  readonly setResolvedPort: (port: number) => void;
  readonly handler: RequestListener;
};

export type ListeningPlanForgeServer = PlanForgeServerParts & {
  readonly server: Server;
};

export function planForgePortFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): number {
  const rawPort = env.PLANFORGE_PORT;
  if (!rawPort) {
    return DEFAULT_PLANFORGE_PORT;
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new PlanForgeError("E_INVALID_PORT", "PLANFORGE_PORT must be an integer from 0 to 65535.");
  }
  return port;
}

function nonEmptyEnv(value: string | undefined): string | null {
  return value && value.trim().length > 0 ? value : null;
}

function planForgeWorkspaceRoot(input: {
  readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly cwd: string;
  readonly workspaceRoot?: string;
}): string {
  return path.resolve(
    input.workspaceRoot ??
      nonEmptyEnv(input.env.PLANFORGE_WORKSPACE_ROOT) ??
      path.resolve(input.cwd, "../../..")
  );
}

// Non-negative integer milliseconds; 0 explicitly disables the wall. An unset or malformed value
// falls back to the default rather than silently disabling the timeout.
function parseTimeoutEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createPlanForgeLoopConfig(
  input: {
    readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    readonly cwd?: string;
    readonly workspaceRoot?: string;
  } = {}
): PlanForgeLoopConfig {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const workspaceRoot = planForgeWorkspaceRoot({ env, cwd, workspaceRoot: input.workspaceRoot });
  const targetRepo = nonEmptyEnv(env.PLANFORGE_TARGET_REPO);
  if (!targetRepo) {
    throw new PlanForgeError(
      "E_TARGET_REPO_UNSET",
      "Set PLANFORGE_TARGET_REPO to the absolute path of the project repo PlanForge should build in. " +
        "There is no implicit default: an unset target previously fell back to the working directory, which for an " +
        "in-estate checkout resolves to the entire estate and could ff-merge it into main."
    );
  }
  const runtimeRoot = nonEmptyEnv(env.PLANFORGE_RUNTIME_ROOT) ?? path.join(workspaceRoot, "shared-runtime", "planforge");
  const verifierName = nonEmptyEnv(env.PLANFORGE_VERIFIER_NAME) ?? DEFAULT_VERIFIER_NAME;
  const verifierCommand = nonEmptyEnv(env.PLANFORGE_VERIFIER_COMMAND) ?? DEFAULT_VERIFIER_COMMAND;
  const verifierTimeoutMs = parseTimeoutEnv(env.PLANFORGE_VERIFIER_TIMEOUT_MS, DEFAULT_VERIFIER_TIMEOUT_MS);
  const architectModels = parseArchitectModelAllowlist(env.PLANFORGE_ARCHITECT_MODELS);
  const builderModels = parseBuilderModelAllowlist(env.PLANFORGE_BUILDER_MODELS);
  const architectEffort = parseOptionalArchitectEffort(env.PLANFORGE_ARCHITECT_EFFORT);
  const builderEffort = parseOptionalBuilderEffort(env.PLANFORGE_BUILDER_EFFORT);
  const architectModel = parseOptionalModel("architect", nonEmptyEnv(env.PLANFORGE_ARCHITECT_MODEL) ?? undefined, architectModels);
  const builderModel = parseOptionalModel("builder", nonEmptyEnv(env.PLANFORGE_BUILDER_MODEL) ?? undefined, builderModels);
  const notifyCommand = nonEmptyEnv(env.PLANFORGE_NOTIFY_COMMAND) ?? undefined;
  const publicUrl = nonEmptyEnv(env.PLANFORGE_PUBLIC_URL) ?? undefined;
  assertAllowedTargetRepo({ targetRepo, workspaceRoot });
  const protectedGlobs = nonEmptyEnv(env.PLANFORGE_PROTECTED_GLOBS)
    ? parseGlobList(env.PLANFORGE_PROTECTED_GLOBS ?? undefined)
    : DEFAULT_PROTECTED_GLOBS;
  const writeScopePolicy: WriteScopePolicy = {
    protectedGlobs,
    allowedGlobs: parseGlobList(env.PLANFORGE_ALLOWED_GLOBS ?? undefined)
  };
  return {
    targetRepo,
    runtimeRoot,
    env,
    verifierCommands: [{ name: verifierName, command: verifierCommand }],
    architectModels,
    builderModels,
    writeScopePolicy,
    verifierTimeoutMs,
    ...(architectEffort ? { architectEffort } : {}),
    ...(builderEffort ? { builderEffort } : {}),
    ...(architectModel ? { architectModel } : {}),
    ...(builderModel ? { builderModel } : {}),
    ...(notifyCommand ? { notifyCommand } : {}),
    ...(publicUrl ? { publicUrl } : {})
  };
}

export function createPlanForgeServer(input: CreatePlanForgeServerInput = {}): PlanForgeServerParts {
  const runService = input.runService ?? createChatRunService();
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const workspaceRoot = planForgeWorkspaceRoot({ env, cwd, workspaceRoot: input.workspaceRoot });
  const loopConfig = input.loopConfig ?? createPlanForgeLoopConfig({ env, cwd, workspaceRoot });
  // Shared runId -> resolved targetRepo map: the orchestrator publishes each conversation's target
  // here; the run-builder + read_repo_file consume it so a per-conversation target is honored.
  const targetRepoStore = new Map<string, string>();
  const runSettingsStore = new Map<string, { readonly builderEffort?: BuilderEffort; readonly builderModel?: string }>();
  // Shared runId -> live MCP transports map: the handler registers each ?runId session here; the
  // orchestrator closes a run's transports at teardown so reaped sessions do not leak them.
  const mcpSessions: McpSessionStore = new Map();
  // The estate root used for the target allowlist (same root createPlanForgeLoopConfig validates
  // against). Reused to (a) validate a per-conversation target at create time and (b) enumerate the
  // allowed targets for the UI picker.
  const validateTargetRepo = (targetRepo: string) => assertAllowedTargetRepo({ targetRepo, workspaceRoot });
  const runBuilder = createPlanForgeRunBuilder({
    runService,
    loopConfig,
    targetRepoStore,
    runSettingsStore,
    workspaceRoot,
    codexRunner: input.codexRunner,
    git: input.git,
    verifierRunner: input.verifierRunner
  });
  const registry = input.registry ?? createPlanForgeRegistry({ runBuilder });
  const host = input.host ?? PLANFORGE_HOST;
  let resolvedPort = input.port ?? planForgePortFromEnv(input.env);
  const getResolvedPort = () => resolvedPort;
  const notifyHook = createNotifyHook({
    command: loopConfig.notifyCommand ?? null,
    ...(loopConfig.publicUrl ? { publicUrl: loopConfig.publicUrl } : {}),
    localOrigin: () => `http://${host}:${getResolvedPort()}`
  });
  const conversationStore =
    input.conversationStore ??
    createConversationStore({
      root: path.join(loopConfig.runtimeRoot, "conversations"),
      validateTargetRepo
    });
  const writeMcpConfig =
    input.writeMcpConfig ??
    (({ runtimeRoot, runId }) =>
      writePlanForgeMcpConfig({
        runtimeRoot,
        runId,
        host,
        port: getResolvedPort()
      }));
  const conversationOrchestrator = createConversationOrchestrator({
    store: conversationStore,
    runService,
    registry,
    runBuilder,
    loopConfig,
    startSession: input.startSession,
    writeMcpConfig,
    git: input.git,
    idleTimeoutMs: input.idleTimeoutMs,
    setTimer: input.setTimer,
    clearTimer: input.clearTimer,
    targetRepoStore,
    runSettingsStore,
    mcpSessions,
    ...(notifyHook ? { notifyHook } : {})
  });
  return {
    host,
    port: resolvedPort,
    registry,
    runService,
    loopConfig,
    conversationStore,
    conversationOrchestrator,
    resolvedPort: getResolvedPort,
    setResolvedPort: (port) => {
      resolvedPort = port;
    },
    handler: createPlanForgeSingleProcessHandler({
      registry,
      runService,
      loopConfig,
      store: conversationStore,
      orchestrator: conversationOrchestrator,
      staticRoot: input.staticRoot,
      resolvedPort: getResolvedPort,
      targetRepoStore,
      mcpSessions,
      workspaceRoot
    })
  };
}

export function listenPlanForgeServer(input: CreatePlanForgeServerInput = {}): Promise<ListeningPlanForgeServer> {
  const parts = createPlanForgeServer(input);
  const server = createServer(parts.handler);
  return new Promise<ListeningPlanForgeServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(parts.port, parts.host, () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : parts.port;
      parts.setResolvedPort(port);
      resolve({ ...parts, port, server });
    });
  });
}

export function defaultPlanForgeStaticRoot(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "dist");
}

async function main(): Promise<void> {
  const server = await listenPlanForgeServer({ staticRoot: defaultPlanForgeStaticRoot() });
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : server.port;
  console.log(`PlanForge listening on http://${server.host}:${port}`);
  // The target passed the standalone-repo assert in createPlanForgeLoopConfig (a real `.git` at its
  // root, not a symlink or an escaping gitfile), so `git rev-parse --show-toplevel` from it is the
  // target itself — the old boot-time enclosing-repo / not-a-repo WARNING can no longer fire and was
  // removed. Just record the effective target.
  console.log(`PlanForge target repo: ${server.loopConfig.targetRepo}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
