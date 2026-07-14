import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PlanForgeError } from "./errors";

export type NotifyEvent = "plan_awaiting_approval" | "cycle_complete";

export type NotifyPayload = {
  readonly event: NotifyEvent;
  readonly conversationId: string;
  readonly title: string;
  readonly state: string;
  readonly url: string;
};

export type NotifyHook = (payload: Omit<NotifyPayload, "url">) => void;

export type NotifySpawn = (
  command: string,
  options: {
    readonly shell: true;
    readonly detached: true;
    readonly stdio: "pipe";
  }
) => ChildProcessWithoutNullStreams;

export type CreateNotifyHookInput = {
  readonly command: string | null;
  readonly publicUrl?: string | null;
  readonly localOrigin: () => string;
  readonly timeoutMs?: number;
  readonly spawn?: NotifySpawn;
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (handle: NodeJS.Timeout) => void;
  readonly log?: (message: string) => void;
};

const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;

function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function conversationUrl(input: {
  readonly publicUrl?: string | null;
  readonly localOrigin: () => string;
  readonly conversationId: string;
}): string {
  const base = trimBaseUrl(input.publicUrl && input.publicUrl.trim().length > 0 ? input.publicUrl : input.localOrigin());
  return `${base}/conversations/${encodeURIComponent(input.conversationId)}`;
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
}

export function createNotifyHook(input: CreateNotifyHookInput): NotifyHook | null {
  const command = input.command?.trim();
  if (!command) {
    return null;
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new PlanForgeError("E_INVALID_NOTIFY_TIMEOUT", "Notify hook timeout must be a positive integer.");
  }
  const spawnChild = input.spawn ?? spawn;
  const setTimer = input.setTimer ?? setTimeout;
  const clearTimer = input.clearTimer ?? clearTimeout;
  const log = input.log ?? ((message) => console.log(message));

  return (payload) => {
    const body = JSON.stringify({
      event: payload.event,
      conversationId: payload.conversationId,
      title: payload.title,
      state: payload.state,
      url: conversationUrl({ publicUrl: input.publicUrl, localOrigin: input.localOrigin, conversationId: payload.conversationId })
    });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnChild(command, { shell: true, detached: true, stdio: "pipe" });
    } catch (error) {
      log(`PlanForge notify hook failed to spawn: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimer(() => {
      timedOut = true;
      killProcessGroup(child.pid);
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimer(timer);
      log(`PlanForge notify hook errored: ${error.message}`);
    });
    child.on("close", (code, signal) => {
      clearTimer(timer);
      const status = timedOut ? `timed out after ${timeoutMs}ms` : `exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      const output = [stdout.trim() ? `stdout: ${stdout.trim()}` : "", stderr.trim() ? `stderr: ${stderr.trim()}` : ""]
        .filter(Boolean)
        .join(" ");
      log(`PlanForge notify hook ${status}.${output ? ` ${output}` : ""}`);
    });
    child.stdin.end(`${body}\n`);
    child.unref();
  };
}
