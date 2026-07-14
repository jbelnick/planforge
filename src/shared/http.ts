import type { IncomingMessage } from "node:http";
import { PlanForgeError } from "../errors";
import type { JsonValue } from "./json";

// Request-body cap for every JSON-reading route (web API and /mcp). This server can be exposed
// beyond loopback (`tailscale serve`), so an unbounded body buffer is a real memory-DoS boundary.
// The cap is enforced while reading — an oversized body is rejected mid-stream, before JSON.parse
// and before the full payload is ever buffered.
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function readJson(req: IncomingMessage, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<JsonValue> {
  return new Promise<JsonValue>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        // Stop reading but do not destroy the request: the socket must stay alive for the caller to
        // deliver the 413. Node drains the unread remainder after the response finishes.
        cleanup();
        req.pause();
        reject(new PlanForgeError("E_PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes.`));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.trim().length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(body) as JsonValue);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}
