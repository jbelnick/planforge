import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARCHITECT_SETTINGS_ENV_VAR,
  DEFAULT_ARCHITECT_SETTINGS_PATH,
  DISALLOWED_ARCHITECT_TOOLS,
  resolveArchitectSettingsPath
} from "../src/architect/claude-driver";
import { parseClaudeStreamJsonLines } from "../src/architect/claude-stream";

const fixturePath = path.join(import.meta.dirname, "fixtures", "architect-stream.jsonl");
const securityCriticalArchitectTools = [
  "Skill",
  "Workflow",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate"
] as const;

describe("Claude architect driver constants", () => {
  it("keeps side-effectful architect built-ins in the denylist", () => {
    for (const tool of securityCriticalArchitectTools) {
      expect(DISALLOWED_ARCHITECT_TOOLS).toContain(tool);
    }
  });

  it("resolves the checked-in settings file by default and honors the env override", () => {
    expect(DEFAULT_ARCHITECT_SETTINGS_PATH).toBe(
      path.resolve(import.meta.dirname, "..", "config", "architect.settings.json")
    );
    expect(resolveArchitectSettingsPath({})).toBe(DEFAULT_ARCHITECT_SETTINGS_PATH);
    // An ABSOLUTE override passes through untouched.
    expect(resolveArchitectSettingsPath({ [ARCHITECT_SETTINGS_ENV_VAR]: "/x/y.json" })).toBe("/x/y.json");
    // Empty (or whitespace-only) override is the escape hatch: no --settings flag at all.
    expect(resolveArchitectSettingsPath({ [ARCHITECT_SETTINGS_ENV_VAR]: "" })).toBeUndefined();
    expect(resolveArchitectSettingsPath({ [ARCHITECT_SETTINGS_ENV_VAR]: "   " })).toBeUndefined();
  });

  it("resolves a RELATIVE override against the server cwd, never the target repo", () => {
    // --settings is flag-level (outranks user/project/local) and claude runs with cwd = the target
    // repo, so a relative override must anchor to the SERVER process cwd (operator-controlled), never
    // resolve inside the builder-reachable target tree.
    expect(resolveArchitectSettingsPath({ [ARCHITECT_SETTINGS_ENV_VAR]: "rel/y.json" }, "/srv/planforge")).toBe(
      path.resolve("/srv/planforge", "rel/y.json")
    );
    expect(resolveArchitectSettingsPath({ [ARCHITECT_SETTINGS_ENV_VAR]: "../escape.json" }, "/srv/planforge")).toBe(
      path.resolve("/srv/planforge", "../escape.json")
    );
    // An absolute override is unaffected by the server cwd.
    expect(resolveArchitectSettingsPath({ [ARCHITECT_SETTINGS_ENV_VAR]: "/abs/y.json" }, "/srv/planforge")).toBe(
      "/abs/y.json"
    );
  });

  it("ships a checked-in settings file that disables hooks and carries no auth material", async () => {
    const raw = await readFile(DEFAULT_ARCHITECT_SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // The load-bearing key: verified live against claude 2.1.198 — with this flag-settings file the
    // session emits ZERO SessionStart hook events (vs 10, incl. the /last30days banner, without it).
    expect(parsed.disableAllHooks).toBe(true);
    // AGENTS.md rule 3 (subscription auth only): the file must never inject API keys or auth, and it
    // must not carry MCP config that could interfere with the per-run config PlanForge injects.
    expect(raw).not.toMatch(/ANTHROPIC|apiKey|authToken|token|mcp/i);
    for (const key of Object.keys(parsed)) {
      expect(["$schema", "disableAllHooks"]).toContain(key);
    }
  });

  it("architect stream-json parse", async () => {
    const fixture = await readFile(fixturePath, "utf8");
    const events = parseClaudeStreamJsonLines(fixture);

    expect(events.map((event) => event.type)).toEqual([
      "status",
      "status",
      "text_delta",
      "tool_use",
      "tool_result"
    ]);
    expect(events[3]).toMatchObject({ type: "tool_use", name: "propose_plan" });
  });
});
