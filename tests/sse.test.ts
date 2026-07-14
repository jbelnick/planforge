import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createChatRunService, type JsonValue } from "../src/run-service";
import { createHttpSseClient } from "../src/http-server";
import { createPlanForgeRegistry } from "../src/registry";
import { createPlanForgeSingleProcessHandler } from "../src/server";

type SseFrame = {
  readonly id: number;
  readonly event: string;
  readonly data: JsonValue;
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  servers.length = 0;
});

function listen(handler: ReturnType<typeof createPlanForgeSingleProcessHandler>): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        resolve(`http://127.0.0.1:${address.port}`);
      }
    });
  });
}

function frameFromText(text: string): SseFrame {
  const idLine = text.split("\n").find((line) => line.startsWith("id: "));
  const eventLine = text.split("\n").find((line) => line.startsWith("event: "));
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!idLine || !eventLine || !dataLine) {
    throw new Error(`Malformed SSE frame: ${text}`);
  }
  return {
    id: Number(idLine.slice("id: ".length)),
    event: eventLine.slice("event: ".length),
    data: JSON.parse(dataLine.slice("data: ".length)) as JsonValue
  };
}

async function readFrames(response: Response, count: number): Promise<SseFrame[]> {
  if (!response.body) {
    throw new Error("SSE response body missing.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: SseFrame[] = [];
  while (frames.length < count) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    while (buffer.includes("\n\n") && frames.length < count) {
      const separatorIndex = buffer.indexOf("\n\n");
      const frameText = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      frames.push(frameFromText(frameText));
    }
  }
  await reader.cancel();
  return frames;
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for assertion.");
}

describe("PlanForge SSE endpoint", () => {
  it("sse stream framing", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const run = runService.create();
    const baseUrl = await listen(createPlanForgeSingleProcessHandler({ registry, runService }));

    runService.emit(run, "plan_proposed", { runId: run.id, title: "Plan", plan: "Approve it." });
    runService.emit(run, "codex_stream", { runId: run.id, chunk: "Codex line" });
    runService.emit(run, "verifier_result", { runId: run.id, status: "pass", verifierResults: [] });

    const response = await fetch(`${baseUrl}/api/runs/${run.id}/events`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    await expect(readFrames(response, 3)).resolves.toEqual([
      { id: 1, event: "plan_proposed", data: { runId: run.id, title: "Plan", plan: "Approve it." } },
      { id: 2, event: "codex_stream", data: { runId: run.id, chunk: "Codex line" } },
      { id: 3, event: "verifier_result", data: { runId: run.id, status: "pass", verifierResults: [] } }
    ]);
  });

  it("sse replay after Last-Event-ID", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const run = runService.create();
    const baseUrl = await listen(createPlanForgeSingleProcessHandler({ registry, runService }));

    runService.emit(run, "plan_proposed", { runId: run.id, title: "Plan", plan: "Approve it." });
    runService.emit(run, "codex_stream", { runId: run.id, chunk: "first" });
    runService.emit(run, "codex_stream", { runId: run.id, chunk: "second" });

    const response = await fetch(`${baseUrl}/api/runs/${run.id}/events`, {
      headers: { "Last-Event-ID": "1" }
    });

    await expect(readFrames(response, 2)).resolves.toEqual([
      { id: 2, event: "codex_stream", data: { runId: run.id, chunk: "first" } },
      { id: 3, event: "codex_stream", data: { runId: run.id, chunk: "second" } }
    ]);
  });

  it("sse close cleanup", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const run = runService.create();
    const baseUrl = await listen(createPlanForgeSingleProcessHandler({ registry, runService }));
    const controller = new AbortController();

    const response = await fetch(`${baseUrl}/api/runs/${run.id}/events`, { signal: controller.signal });
    expect(response.ok).toBe(true);

    await waitFor(() => run.clients.size === 1);
    controller.abort();
    await waitFor(() => run.clients.size === 0);
  });

  it("http sse fans out terminal error and end frames to two clients", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const run = runService.create();
    const baseUrl = await listen(createPlanForgeSingleProcessHandler({ registry, runService }));

    const first = await fetch(`${baseUrl}/api/runs/${run.id}/events`);
    const second = await fetch(`${baseUrl}/api/runs/${run.id}/events`);
    await waitFor(() => run.clients.size === 2);
    runService.fail(run, "TEST_FAILURE", "terminal failure");

    const expected = [
      { id: 1, event: "error", data: { code: "TEST_FAILURE", message: "terminal failure" } },
      { id: 2, event: "end", data: { code: 1, signal: null, status: "failed" } }
    ];
    await expect(readFrames(first, 2)).resolves.toEqual(expected);
    await expect(readFrames(second, 2)).resolves.toEqual(expected);
  });
});

type FakeResponse = {
  readonly emitter: EventEmitter;
  readonly res: ServerResponse;
  readonly writes: string[];
  ended: boolean;
};

function fakeResponse(): FakeResponse {
  const emitter = new EventEmitter();
  const state: { ended: boolean } = { ended: false };
  const writes: string[] = [];
  const res = Object.assign(emitter, {
    writableEnded: false,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
    end(): unknown {
      state.ended = true;
      return res;
    }
  }) as unknown as ServerResponse;
  return {
    emitter,
    res,
    writes,
    get ended() {
      return state.ended;
    }
  };
}

describe("createHttpSseClient socket-error latch", () => {
  it("no-ops send and end after the response emits 'error' so a dead socket cannot escalate", () => {
    const fake = fakeResponse();
    const client = createHttpSseClient(fake.res);

    client.send("plan_proposed", { ok: true });
    expect(fake.writes).toHaveLength(1);

    // A dead socket surfaces asynchronously as an 'error' event, not a thrown write.
    fake.emitter.emit("error", new Error("ECONNRESET"));

    client.send("verifier_result", { ok: true });
    client.end();
    expect(fake.writes).toHaveLength(1);
    expect(fake.ended).toBe(false);
  });

  it("does not throw when the response emits 'error' with no other listener attached", () => {
    const fake = fakeResponse();
    createHttpSseClient(fake.res);
    expect(() => fake.emitter.emit("error", new Error("EPIPE"))).not.toThrow();
  });
});
