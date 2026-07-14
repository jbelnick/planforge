import { spawn } from "node:child_process";
import type { DaemonAgentPayload } from "../domain";
import type { ArchitectEffort } from "../effort";
import { PlanForgeError } from "../errors";
import { copyEnv } from "../shared/env";
import { createClaudeStreamParser } from "./claude-stream";
import {
  ARCHITECT_SETTING_SOURCES,
  DISALLOWED_ARCHITECT_TOOLS,
  resolveArchitectSettingsPath,
  type ClaudeSpawnResult
} from "./claude-driver";

export type BuildArchitectSessionArgsInput = {
  readonly sessionId: string;
  readonly mcpConfigPath: string;
  readonly resume?: boolean;
  readonly systemPrompt?: string;
  readonly effort?: ArchitectEffort;
  readonly model?: string;
  // Already-resolved --settings file path; undefined omits the flag. Production resolution happens in
  // startArchitectSession via resolveArchitectSettingsPath (default = the checked-in
  // config/architect.settings.json; PLANFORGE_ARCHITECT_SETTINGS overrides; empty value disables).
  readonly settingsPath?: string;
};

export type ArchitectSessionSpawnRequest = {
  readonly bin: "claude";
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  // Working directory for the architect process: the resolved target repo, so CLAUDE.md/hook
  // resolution happens in the target rather than PlanForge's own tree. Undefined inherits the parent.
  readonly cwd?: string;
  readonly onStdout: (chunk: string) => void;
  readonly onStderr: (chunk: string) => void;
};

export type ArchitectSessionProcess = {
  write(line: string): void;
  end(): void;
  readonly done: Promise<ClaudeSpawnResult>;
};

export type ArchitectSessionSpawn = (request: ArchitectSessionSpawnRequest) => ArchitectSessionProcess;

export type StartArchitectSessionInput = BuildArchitectSessionArgsInput & {
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly cwd?: string;
  readonly onEvent?: (event: DaemonAgentPayload) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly spawn?: ArchitectSessionSpawn;
};

export type ArchitectSession = {
  send(text: string): void;
  end(): void;
  readonly done: Promise<ClaudeSpawnResult>;
};

export function buildArchitectSessionArgs(input: BuildArchitectSessionArgsInput): string[] {
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    ARCHITECT_SETTING_SOURCES,
    ...(input.settingsPath !== undefined ? ["--settings", input.settingsPath] : []),
    "--permission-mode",
    "bypassPermissions",
    "--mcp-config",
    input.mcpConfigPath,
    "--strict-mcp-config",
    "--disallowed-tools",
    ...DISALLOWED_ARCHITECT_TOOLS
  ];
  args.push(input.resume ? "--resume" : "--session-id", input.sessionId);
  if (input.systemPrompt) {
    args.push("--append-system-prompt", input.systemPrompt);
  }
  if (input.effort) {
    args.push("--effort", input.effort);
  }
  if (input.model && input.model !== "default") {
    args.push("--model", input.model);
  }
  return args;
}

export function encodeUserTurn(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

function defaultArchitectSessionSpawn(request: ArchitectSessionSpawnRequest): ArchitectSessionProcess {
  const child = spawn(request.bin, request.args, {
    env: request.env,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk: string | Buffer) => request.onStdout(chunk.toString()));
  child.stderr.on("data", (chunk: string | Buffer) => request.onStderr(chunk.toString()));
  const done = new Promise<ClaudeSpawnResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  return {
    write(line) {
      child.stdin.write(line);
    },
    end() {
      child.stdin.end();
    },
    done
  };
}

export function startArchitectSession(input: StartArchitectSessionInput): ArchitectSession {
  const parser = createClaudeStreamParser(input.onEvent ?? (() => {}));
  const env = copyEnv(input.env ?? process.env);
  // Resolve --settings from the SAME env the child inherits, so the operator's
  // PLANFORGE_ARCHITECT_SETTINGS override (or empty-value opt-out) governs exactly this spawn.
  const settingsPath = input.settingsPath ?? resolveArchitectSettingsPath(env);
  const sessionProcess = (input.spawn ?? defaultArchitectSessionSpawn)({
    bin: "claude",
    args: buildArchitectSessionArgs({
      ...input,
      ...(settingsPath !== undefined ? { settingsPath } : {})
    }),
    env,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    onStdout(chunk) {
      parser.feed(chunk);
    },
    onStderr: input.onStderr ?? (() => {})
  });
  let closed = false;
  const done = sessionProcess.done.then(
    (result) => {
      closed = true;
      parser.flush();
      return result;
    },
    (error: Error) => {
      closed = true;
      parser.flush();
      throw error;
    }
  );
  return {
    send(text) {
      if (closed) {
        throw new PlanForgeError("E_SESSION_CLOSED", "Cannot send to a closed architect session.");
      }
      sessionProcess.write(encodeUserTurn(text));
    },
    end() {
      if (!closed) {
        closed = true;
        sessionProcess.end();
      }
    },
    done
  };
}
