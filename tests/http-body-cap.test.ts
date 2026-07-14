import { Readable } from "node:stream";
import { createServer, type Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { PlanForgeError } from "../src/errors";
import { createChatRunService } from "../src/run-service";
import { createPlanForgeRegistry } from "../src/registry";
import { createPlanForgeSingleProcessHandler } from "../src/server";
import { MAX_JSON_BODY_BYTES, readJson } from "../src/shared/http";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
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

describe("readJson body cap", () => {
  it("rejects while reading, before buffering the full body", async () => {
    const chunk = Buffer.alloc(64 * 1024, "a");
    const totalChunks = 64; // 4 MiB if fully read
    let produced = 0;
    const req = new Readable({
      read() {
        if (produced >= totalChunks) {
          this.push(null);
          return;
        }
        produced += 1;
        this.push(chunk);
      }
    }) as unknown as IncomingMessage;

    await expect(readJson(req)).rejects.toMatchObject({
      name: "PlanForgeError",
      code: "E_PAYLOAD_TOO_LARGE"
    });
    // The cap fired mid-stream: only just past 1 MiB of the 4 MiB body was ever pulled.
    expect(produced).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES / chunk.byteLength + 2);
  });

  it("still parses a body under the cap and returns null for an empty body", async () => {
    const small = Readable.from([Buffer.from('{"ok":true}')]) as unknown as IncomingMessage;
    await expect(readJson(small)).resolves.toEqual({ ok: true });
    const empty = Readable.from([]) as unknown as IncomingMessage;
    await expect(readJson(empty)).resolves.toBeNull();
  });

  it("rejects malformed JSON under the cap with the parse error", async () => {
    const malformed = () => Readable.from([Buffer.from("{nope")]) as unknown as IncomingMessage;
    await expect(readJson(malformed())).rejects.toBeInstanceOf(SyntaxError);
    await expect(readJson(malformed())).rejects.not.toBeInstanceOf(PlanForgeError);
  });
});

describe("HTTP routes enforce the body cap", () => {
  it("responds 413 to an oversized POST /api/runs/:id/approve body", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const baseUrl = await listen(createPlanForgeSingleProcessHandler({ registry, runService }));

    const oversized = JSON.stringify({ verdict: "approved", feedback: "x".repeat(MAX_JSON_BODY_BYTES + 1024) });
    const response = await fetch(`${baseUrl}/api/runs/run-cap/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "E_PAYLOAD_TOO_LARGE" });
  });

  it("responds 413 to an oversized POST /mcp body", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const baseUrl = await listen(createPlanForgeSingleProcessHandler({ registry, runService }));

    const oversized = JSON.stringify({ jsonrpc: "2.0", method: "noop", params: { blob: "x".repeat(MAX_JSON_BODY_BYTES + 1024) } });
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: oversized
    });
    expect(response.status).toBe(413);
  });

  it("keeps a small POST /api/runs/:id/approve body flowing to schema validation", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const baseUrl = await listen(createPlanForgeSingleProcessHandler({ registry, runService }));

    const response = await fetch(`${baseUrl}/api/runs/run-cap/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wrong: "shape" })
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "E_INVALID_APPROVAL" });
  });
});
