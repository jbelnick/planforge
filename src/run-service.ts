import { randomUUID } from "node:crypto";

import { PlanForgeError } from "./errors";
import type { JsonObject, JsonValue } from "./shared/json";

export type { JsonArray, JsonObject, JsonPrimitive, JsonValue } from "./shared/json";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "succeeded",
  "failed",
  "canceled"
]);

export type RunMeta = {
  readonly projectId?: string | null;
  readonly conversationId?: string | null;
  readonly assistantMessageId?: string | null;
  readonly clientRequestId?: string | null;
  readonly agentId?: string | null;
};

export type SseRecord = {
  readonly id: number;
  readonly event: string;
  readonly data: JsonValue;
};

export type SseClient<TData extends JsonValue = JsonValue> = {
  send(event: string, data: TData, id?: number): void;
  end(): void;
  cleanup(): void;
};

export type RunStatusBody = {
  readonly id: string;
  readonly projectId: string | null;
  readonly conversationId: string | null;
  readonly assistantMessageId: string | null;
  readonly clientRequestId: string | null;
  readonly agentId: string | null;
  readonly status: RunStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
};

export type ChatRun = RunStatusBody & {
  status: RunStatus;
  updatedAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  readonly events: SseRecord[];
  nextEventId: number;
  readonly clients: Set<SseClient>;
  readonly waiters: Set<(body: RunStatusBody) => void>;
  cancelRequested: boolean;
  child:
    | {
        readonly killed: boolean;
        kill(signal: NodeJS.Signals): boolean;
      }
    | null;
  cleanup?: () => void;
};

export type SubscribeOptions = {
  readonly lastEventId?: number;
};

export type CreateChatRunServiceOptions = {
  readonly maxEvents?: number;
  readonly ttlMs?: number;
  readonly idFactory?: () => string;
  readonly now?: () => number;
};

function nullableString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function createErrorPayload(code: string, message: string, detail?: JsonObject): JsonObject {
  return detail ? { code, message, detail } : { code, message };
}

export function createChatRunService(options: CreateChatRunServiceOptions = {}) {
  const maxEvents = options.maxEvents ?? 2_000;
  const ttlMs = options.ttlMs ?? 30 * 60 * 1000;
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? Date.now;
  const runs = new Map<string, ChatRun>();

  function create(meta: RunMeta = {}): ChatRun {
    const createdAt = now();
    const run: ChatRun = {
      id: idFactory(),
      projectId: nullableString(meta.projectId),
      conversationId: nullableString(meta.conversationId),
      assistantMessageId: nullableString(meta.assistantMessageId),
      clientRequestId: nullableString(meta.clientRequestId),
      agentId: nullableString(meta.agentId),
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      events: [],
      nextEventId: 1,
      clients: new Set(),
      waiters: new Set(),
      child: null,
      exitCode: null,
      signal: null,
      cancelRequested: false
    };
    runs.set(run.id, run);
    return run;
  }

  function statusBody(run: ChatRun): RunStatusBody {
    return {
      id: run.id,
      projectId: run.projectId,
      conversationId: run.conversationId,
      assistantMessageId: run.assistantMessageId,
      clientRequestId: run.clientRequestId,
      agentId: run.agentId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      exitCode: run.exitCode,
      signal: run.signal
    };
  }

  function scheduleCleanup(run: ChatRun): void {
    const timeout = setTimeout(() => {
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        runs.delete(run.id);
      }
    }, ttlMs);
    timeout.unref?.();
  }

  function emit(run: ChatRun, event: string, data: JsonValue): SseRecord {
    const record = { id: run.nextEventId, event, data };
    run.nextEventId += 1;
    run.events.push(record);
    if (run.events.length > maxEvents) {
      run.events.splice(0, run.events.length - maxEvents);
    }
    run.updatedAt = now();
    for (const client of run.clients) {
      client.send(event, data, record.id);
    }
    return record;
  }

  function markRunning(run: ChatRun): void {
    if (run.status !== "queued") {
      return;
    }
    run.status = "running";
    run.updatedAt = now();
  }

  function finish(
    run: ChatRun,
    status: Extract<RunStatus, "succeeded" | "failed" | "canceled">,
    code: number | null = null,
    signal: NodeJS.Signals | null = null
  ): void {
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return;
    }
    run.status = status;
    run.exitCode = code;
    run.signal = signal;
    run.updatedAt = now();
    run.cleanup?.();
    emit(run, "end", { code, signal, status });
    for (const client of run.clients) {
      client.end();
    }
    run.clients.clear();
    const body = statusBody(run);
    for (const waiter of run.waiters) {
      waiter(body);
    }
    run.waiters.clear();
    scheduleCleanup(run);
  }

  function fail(run: ChatRun, code: string, message: string, detail?: JsonObject): void {
    emit(run, "error", createErrorPayload(code, message, detail));
    finish(run, "failed", 1, null);
  }

  function cancel(run: ChatRun): void {
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return;
    }
    run.cancelRequested = true;
    run.updatedAt = now();
    if (run.child && !run.child.killed) {
      run.child.kill("SIGTERM");
      return;
    }
    finish(run, "canceled", null, "SIGTERM");
  }

  function wait(run: ChatRun): Promise<RunStatusBody> {
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return Promise.resolve(statusBody(run));
    }
    return new Promise((resolve) => run.waiters.add(resolve));
  }

  function subscribe(run: ChatRun, client: SseClient, options: SubscribeOptions = {}): () => void {
    const lastEventId = Number.isFinite(options.lastEventId) ? options.lastEventId ?? 0 : 0;
    for (const record of run.events) {
      if (record.id > lastEventId) {
        client.send(record.event, record.data, record.id);
      }
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      client.end();
      return () => client.cleanup();
    }
    run.clients.add(client);
    return () => {
      run.clients.delete(client);
      client.cleanup();
    };
  }

  function get(id: string): ChatRun | null {
    return runs.get(id) ?? null;
  }

  function list(filter: { readonly status?: RunStatus | "active"; readonly projectId?: string } = {}): ChatRun[] {
    return Array.from(runs.values()).filter((run) => {
      if (filter.projectId && run.projectId !== filter.projectId) {
        return false;
      }
      if (filter.status === "active") {
        return !TERMINAL_RUN_STATUSES.has(run.status);
      }
      if (filter.status) {
        return run.status === filter.status;
      }
      return true;
    });
  }

  async function start(run: ChatRun, starter: (run: ChatRun) => Promise<void> | void): Promise<ChatRun> {
    markRunning(run);
    try {
      await starter(run);
    } catch (error) {
      const code = error instanceof PlanForgeError ? error.code : "AGENT_EXECUTION_FAILED";
      fail(run, code, error instanceof Error ? error.message : String(error));
    }
    return run;
  }

  return {
    create,
    start,
    get,
    list,
    subscribe,
    cancel,
    wait,
    emit,
    markRunning,
    finish,
    fail,
    statusBody,
    isTerminal(status: RunStatus): boolean {
      return TERMINAL_RUN_STATUSES.has(status);
    }
  };
}

export type ChatRunService = ReturnType<typeof createChatRunService>;
