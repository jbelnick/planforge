import { describe, expect, it } from "vitest";
import {
  ARCHITECT_SETTINGS_ENV_VAR,
  DEFAULT_ARCHITECT_SETTINGS_PATH,
  DISALLOWED_ARCHITECT_TOOLS,
  type ClaudeSpawnResult
} from "../src/architect/claude-driver";
import {
  buildArchitectSessionArgs,
  encodeUserTurn,
  startArchitectSession,
  type ArchitectSessionSpawn,
  type ArchitectSessionSpawnRequest
} from "../src/architect/claude-session";
import type { DaemonAgentPayload } from "../src/domain";

const sessionId = "11111111-1111-4111-8111-111111111111";
const mcpConfigPath = "/tmp/planforge-mcp.json";

function fixedArgs(settingsPath?: string): string[] {
  return [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "user",
    ...(settingsPath !== undefined ? ["--settings", settingsPath] : []),
    "--permission-mode",
    "bypassPermissions",
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--disallowed-tools",
    ...DISALLOWED_ARCHITECT_TOOLS
  ];
}

const fixedSessionArgs = fixedArgs();
// startArchitectSession resolves --settings from the spawn env; with no override the argv always
// carries the checked-in architect settings file.
const defaultSpawnArgs = fixedArgs(DEFAULT_ARCHITECT_SETTINGS_PATH);

async function spawnArgsFor(env: Record<string, string | undefined>): Promise<readonly string[]> {
  let capturedArgs: readonly string[] = [];
  const fakeSpawn: ArchitectSessionSpawn = (request) => {
    capturedArgs = request.args;
    return {
      write() {},
      end() {},
      done: Promise.resolve({ exitCode: 0, signal: null })
    };
  };
  const session = startArchitectSession({ sessionId, mcpConfigPath, env, spawn: fakeSpawn });
  await session.done;
  return capturedArgs;
}

function makeAssistantTextLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-session",
      content: [{ type: "text", text }]
    }
  });
}

function makeResultLine(): string {
  return JSON.stringify({
    type: "result",
    usage: { input_tokens: 7, output_tokens: 3 },
    total_cost_usd: 0.012,
    duration_ms: 42
  });
}

describe("Claude streaming architect session", () => {
  it("builds the fresh session argv without a positional prompt", () => {
    const args = buildArchitectSessionArgs({ sessionId, mcpConfigPath });

    expect(args).toEqual([...fixedSessionArgs, "--session-id", sessionId]);
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--model");
    // The pure argv builder only emits --settings when handed a resolved path; the production
    // default is resolved in startArchitectSession (pinned in the settings suite below).
    expect(args).not.toContain("--settings");
  });

  it("threads --settings into the argv when a resolved settings path is provided", () => {
    const args = buildArchitectSessionArgs({ sessionId, mcpConfigPath, settingsPath: "/tmp/custom.settings.json" });

    const index = args.indexOf("--settings");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(args[index + 1]).toBe("/tmp/custom.settings.json");
    expect(args).toEqual(fixedArgs("/tmp/custom.settings.json").concat("--session-id", sessionId));
  });

  it("builds resume argv and optional flags when provided", () => {
    const args = buildArchitectSessionArgs({
      sessionId,
      mcpConfigPath,
      resume: true,
      systemPrompt: "Stay in PlanForge.",
      effort: "max",
      model: "opus"
    });

    expect(args).toEqual([
      ...fixedSessionArgs,
      "--resume",
      sessionId,
      "--append-system-prompt",
      "Stay in PlanForge.",
      "--effort",
      "max",
      "--model",
      "opus"
    ]);
    expect(args).not.toContain("--session-id");
  });

  it("omits the model flag for the default model", () => {
    const args = buildArchitectSessionArgs({ sessionId, mcpConfigPath, model: "default" });

    expect(args).not.toContain("--model");
  });

  it("uses the exported disallowed-tools segment as the single source of truth", () => {
    const args = buildArchitectSessionArgs({ sessionId, mcpConfigPath });
    const disallowedToolsIndex = args.indexOf("--disallowed-tools");

    expect(args.slice(disallowedToolsIndex + 1, disallowedToolsIndex + 1 + DISALLOWED_ARCHITECT_TOOLS.length)).toEqual([
      ...DISALLOWED_ARCHITECT_TOOLS
    ]);
  });

  it("passes the checked-in architect settings file via --settings by default", async () => {
    const args = await spawnArgsFor({ PATH: "/usr/bin" });

    const index = args.indexOf("--settings");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(args[index + 1]).toBe(DEFAULT_ARCHITECT_SETTINGS_PATH);
    expect(args).toEqual([...defaultSpawnArgs, "--session-id", sessionId]);
  });

  it("respects a PLANFORGE_ARCHITECT_SETTINGS override path", async () => {
    const args = await spawnArgsFor({
      PATH: "/usr/bin",
      [ARCHITECT_SETTINGS_ENV_VAR]: "/etc/planforge/other.settings.json"
    });

    const index = args.indexOf("--settings");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(args[index + 1]).toBe("/etc/planforge/other.settings.json");
    expect(args).not.toContain(DEFAULT_ARCHITECT_SETTINGS_PATH);
  });

  it("omits --settings entirely when PLANFORGE_ARCHITECT_SETTINGS is set but empty (escape hatch)", async () => {
    const args = await spawnArgsFor({ PATH: "/usr/bin", [ARCHITECT_SETTINGS_ENV_VAR]: "" });

    expect(args).not.toContain("--settings");
    expect(args).toEqual([...fixedSessionArgs, "--session-id", sessionId]);
  });

  it("loads ONLY user settings so target-controlled project/local settings never inject", () => {
    const args = buildArchitectSessionArgs({ sessionId, mcpConfigPath });
    const index = args.indexOf("--setting-sources");

    // The architect runs with cwd = the target repo, so `project`/`local` sources would resolve to the
    // TARGET's (builder-reachable) .claude/settings.json — which can set env (ANTHROPIC_BASE_URL) or
    // apiKeyHelper. It must load ONLY the operator's user settings (needed for subscription OAuth);
    // personal user-level hooks/skills are neutralized by disableAllHooks + --strict-mcp-config + the
    // disallowed-tools denylist. Project CONTEXT (CLAUDE.md/AGENTS.md) comes from cwd, not this flag.
    expect(index).toBeGreaterThanOrEqual(0);
    expect(args[index + 1]).toBe("user");
    expect(args[index + 1]).not.toContain("project");
    expect(args[index + 1]).not.toContain("local");
    // --bare would break subscription auth (it skips keychain reads); never use it for isolation.
    expect(args).not.toContain("--bare");
  });

  it("passes the parent ANTHROPIC_API_KEY through untouched (subscription env hygiene)", async () => {
    const spawnedEnvs: NodeJS.ProcessEnv[] = [];
    const fakeSpawn: ArchitectSessionSpawn = (request) => {
      spawnedEnvs.push(request.env);
      return {
        write() {},
        end() {},
        done: Promise.resolve({ exitCode: 0, signal: null })
      };
    };

    const session = startArchitectSession({
      sessionId,
      mcpConfigPath,
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sentinel" },
      spawn: fakeSpawn
    });
    await session.done;

    expect(spawnedEnvs).toHaveLength(1);
    expect(spawnedEnvs[0]?.ANTHROPIC_API_KEY).toBe("sentinel");
  });

  it("never injects ANTHROPIC_API_KEY when the parent env has none", async () => {
    const spawnedEnvs: NodeJS.ProcessEnv[] = [];
    const fakeSpawn: ArchitectSessionSpawn = (request) => {
      spawnedEnvs.push(request.env);
      return {
        write() {},
        end() {},
        done: Promise.resolve({ exitCode: 0, signal: null })
      };
    };

    const session = startArchitectSession({
      sessionId,
      mcpConfigPath,
      env: { PATH: "/usr/bin" },
      spawn: fakeSpawn
    });
    await session.done;

    expect(spawnedEnvs).toHaveLength(1);
    expect("ANTHROPIC_API_KEY" in spawnedEnvs[0]!).toBe(false);
  });

  it("runs the architect process in the resolved target cwd", async () => {
    let capturedRequest: ArchitectSessionSpawnRequest | null = null;
    const fakeSpawn: ArchitectSessionSpawn = (request) => {
      capturedRequest = request;
      return {
        write() {},
        end() {},
        done: Promise.resolve({ exitCode: 0, signal: null })
      };
    };

    const session = startArchitectSession({
      sessionId,
      mcpConfigPath,
      cwd: "/repos/target",
      spawn: fakeSpawn
    });
    await session.done;

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.cwd).toBe("/repos/target");
  });

  it("encodes user turns with the verified newline-delimited envelope", () => {
    const text = "Remember alpha, then answer beta.";
    const encoded = encodeUserTurn(text);

    expect(encoded).toBe(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    expect(encoded.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(encoded) as { readonly message: { readonly content: string } };
    expect(parsed.message.content).toBe(text);
  });

  it("streams turns through an injected persistent spawn", async () => {
    const writes: string[] = [];
    const stderrChunks: string[] = [];
    const events: DaemonAgentPayload[] = [];
    let endCalled = false;
    let resolveDone: (result: ClaudeSpawnResult) => void = () => {};
    let capturedRequest: ArchitectSessionSpawnRequest | null = null;
    const fakeSpawn: ArchitectSessionSpawn = (request) => {
      capturedRequest = request;
      const done = new Promise<ClaudeSpawnResult>((resolve) => {
        resolveDone = resolve;
        request.onStderr("known stderr chunk\n");
        request.onStdout(`${makeAssistantTextLine("session response")}\n${makeResultLine()}\n`);
      });
      return {
        write(line) {
          writes.push(line);
        },
        end() {
          endCalled = true;
          resolveDone({ exitCode: 0, signal: null });
        },
        done
      };
    };

    const session = startArchitectSession({
      sessionId,
      mcpConfigPath,
      env: { PATH: "/usr/bin" },
      onEvent: (event) => events.push(event),
      onStderr: (chunk) => stderrChunks.push(chunk),
      spawn: fakeSpawn
    });
    session.send("a");
    session.send("b");
    session.end();
    const result = await session.done;

    expect(capturedRequest).toMatchObject({
      bin: "claude",
      args: [...defaultSpawnArgs, "--session-id", sessionId],
      env: { PATH: "/usr/bin" }
    });
    expect(writes).toEqual([encodeUserTurn("a"), encodeUserTurn("b")]);
    expect(endCalled).toBe(true);
    expect(result).toEqual({ exitCode: 0, signal: null });
    expect(stderrChunks).toEqual(["known stderr chunk\n"]);
    expect(events).toEqual([
      { type: "text_delta", delta: "session response" },
      {
        type: "usage",
        usage: { input_tokens: 7, output_tokens: 3 },
        costUsd: 0.012,
        durationMs: 42
      }
    ]);
    expect(() => session.send("c")).toThrow(expect.objectContaining({ code: "E_SESSION_CLOSED" }));
  });

  it("rejects sends after the process has completed without an explicit end", async () => {
    let resolveDone: (result: ClaudeSpawnResult) => void = () => {};
    const fakeSpawn: ArchitectSessionSpawn = () => ({
      write() {},
      end() {},
      done: new Promise<ClaudeSpawnResult>((resolve) => {
        resolveDone = resolve;
      })
    });

    const session = startArchitectSession({
      sessionId,
      mcpConfigPath,
      spawn: fakeSpawn
    });
    resolveDone({ exitCode: 1, signal: null });
    await session.done;

    expect(() => session.send("after close")).toThrow(expect.objectContaining({ code: "E_SESSION_CLOSED" }));
  });
});
