import path from "node:path";
import { fileURLToPath } from "node:url";

// The architect runs with cwd = the TARGET repo (so its project context — CLAUDE.md/AGENTS.md — is the
// target's). That cwd makes `project` and `local` setting sources resolve to the TARGET's
// `.claude/settings.json` / `settings.local.json` — files the builder can reach through the merge
// channel. Those settings can set `env` (e.g. ANTHROPIC_BASE_URL, redirecting the subscription OAuth
// token to an attacker) or `apiKeyHelper` (arbitrary shell run at session start); `disableAllHooks`
// does NOT cover either. So the architect loads ONLY `user` settings — the operator's own trusted
// config, needed for subscription OAuth — and never the target-controlled project/local layers.
// Project *context* is independent of this flag: CLAUDE.md/AGENTS.md come from cwd, so the architect
// still reads the target's instructions. Personal user-level hooks/skills that this leaves in are
// neutralized downstream (disableAllHooks below + --strict-mcp-config + the disallowed-tools denylist),
// so the deterministic-sub-agent property holds without exposing the injection surface. `--bare` would
// break subscription auth (it skips keychain reads); never use it here.
export const ARCHITECT_SETTING_SOURCES = "user";

// `--setting-sources user` still admits the operator's own SessionStart hooks, and installed plugins
// live in a device-level registry (~/.claude/plugins/installed_plugins.json), not in a settings source,
// so a plugin SessionStart hook (the observed `/last30days: Ready to use…` banner) can otherwise fire
// and get injected as conversation context. The checked-in flag-settings file sets
// `disableAllHooks: true` — a real settings key ("Disable all hooks and statusLine execution") that the
// flag source applies ABOVE user/project/local (settings precedence: user < project < local < flag <
// policy), verified live against claude 2.1.198 with --include-hook-events: 10 SessionStart hook events
// without the file, 0 with it. There is no settings key that disables plugins wholesale
// (`enabledPlugins` has no wildcard), but the remaining plugin surface is already unreachable:
// --strict-mcp-config drops plugin MCP servers and the Skill / Task / ToolSearch built-ins are
// disallowed. The file must never carry ANTHROPIC_API_KEY or any auth.
export const DEFAULT_ARCHITECT_SETTINGS_PATH = fileURLToPath(
  new URL("../../config/architect.settings.json", import.meta.url)
);

export const ARCHITECT_SETTINGS_ENV_VAR = "PLANFORGE_ARCHITECT_SETTINGS";

// Resolve the --settings file for the architect spawn: unset env → the checked-in default;
// a non-empty value → operator override path; an EMPTY value → no --settings flag at all
// (the escape hatch preserving pre-settings-file behavior).
//
// A --settings value is FLAG-level, which outranks user/project/local. The architect runs with
// cwd = the target repo, so a RELATIVE override would resolve against the (builder-reachable) target
// tree — letting a target-controlled file dictate the highest-precedence settings. Resolve a relative
// override against the SERVER process cwd (operator-controlled) so the path is anchored where the
// operator set the env var, never inside the target. Absolute overrides pass through untouched.
export function resolveArchitectSettingsPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  serverCwd: string = process.cwd()
): string | undefined {
  const override = env[ARCHITECT_SETTINGS_ENV_VAR];
  if (override === undefined) {
    return DEFAULT_ARCHITECT_SETTINGS_PATH;
  }
  const trimmed = override.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(serverCwd, trimmed);
}

// Under bypassPermissions, every available built-in auto-executes; leave only PlanForge MCP tools reachable.
export const DISALLOWED_ARCHITECT_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Task",
  "TodoWrite",
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Monitor",
  "PushNotification",
  "RemoteTrigger",
  "ScheduleWakeup",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "ToolSearch",
  "Workflow"
] as const;

export type ClaudeSpawnResult = {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
};
