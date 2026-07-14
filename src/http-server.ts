import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PlanForgeError } from "./errors";
import type { ChatRunService, JsonValue, SseClient } from "./run-service";
import type { PlanForgeRegistry } from "./registry";
import { approvalInputSchema, type PlanForgeToolLoopConfig } from "./tools";
import type { ConversationOrchestrator } from "./conversation-orchestrator";
import type { Conversation, ConversationStore } from "./conversation-store";
import {
  ARCHITECT_EFFORTS,
  BUILDER_EFFORTS,
  parseOptionalArchitectEffort,
  parseOptionalBuilderEffort,
  type ArchitectEffort,
  type BuilderEffort
} from "./effort";
import { parseArchitectModelAllowlist, parseBuilderModelAllowlist, parseOptionalModel } from "./model-config";
import { headerValue, readJson } from "./shared/http";
import { containsPath } from "./shared/paths";
import { listAllowedTargetRepos } from "./target-allowlist";

type JsonResponse = {
  readonly status: number;
  readonly body: JsonValue;
};

const runIdParamSchema = z.object({ runId: z.string().min(1) });
export const lastEventIdSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number(value))
  .refine(Number.isSafeInteger)
  .optional();
const conversationIdSchema = z.string().uuid();
const createConversationInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  // Optional allowlisted build target for this conversation. Validated by the store's
  // validateTargetRepo gate; an allowlisted repo the conversation builds in instead of the default.
  targetRepo: z.string().trim().min(1).optional(),
  architectModel: z.string().trim().min(1).optional(),
  architectEffort: z.string().trim().min(1).optional(),
  builderModel: z.string().trim().min(1).optional(),
  builderEffort: z.string().trim().min(1).optional()
});
// PATCH /api/conversations/:id edits a conversation's mutable properties: its title and/or its
// (pre-start) build target. At least one must be present; an empty PATCH is rejected.
const patchConversationInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    targetRepo: z.string().trim().min(1).optional(),
    architectModel: z.string().trim().min(1).optional(),
    architectEffort: z.string().trim().min(1).optional(),
    builderModel: z.string().trim().min(1).optional(),
    builderEffort: z.string().trim().min(1).optional()
  })
  .refine((data) => data.title !== undefined || hasRunControlFields(data), {
    message: "Provide a title, targetRepo, model, or effort value to update."
  });
const messageInputSchema = z.object({
  text: z.string().trim().min(1).max(20_000)
});
const conversationApprovalInputSchema = z.object({
  verdict: z.enum(["approved", "changes_requested"]),
  feedback: z.string().trim().min(1).max(20_000).optional()
});

type ConversationRunControlInput = {
  readonly targetRepo?: string;
  readonly architectModel?: string;
  readonly architectEffort?: string;
  readonly builderModel?: string;
  readonly builderEffort?: string;
};

type ParsedConversationRunControls = {
  readonly targetRepo?: string;
  readonly architectModel?: string;
  readonly architectEffort?: ArchitectEffort;
  readonly builderModel?: string;
  readonly builderEffort?: BuilderEffort;
};

function hasRunControlFields(data: ConversationRunControlInput): boolean {
  return (
    data.targetRepo !== undefined ||
    data.architectModel !== undefined ||
    data.architectEffort !== undefined ||
    data.builderModel !== undefined ||
    data.builderEffort !== undefined
  );
}

function parseConversationRunControls(
  data: ConversationRunControlInput,
  loopConfig: PlanForgeToolLoopConfig | undefined
): ParsedConversationRunControls {
  const architectModels = loopConfig?.architectModels ?? parseArchitectModelAllowlist(undefined);
  const builderModels = loopConfig?.builderModels ?? parseBuilderModelAllowlist(undefined);
  return {
    ...(data.targetRepo !== undefined ? { targetRepo: data.targetRepo } : {}),
    ...(data.architectModel !== undefined
      ? { architectModel: parseOptionalModel("architect", data.architectModel, architectModels) }
      : {}),
    ...(data.architectEffort !== undefined
      ? { architectEffort: parseOptionalArchitectEffort(data.architectEffort) }
      : {}),
    ...(data.builderModel !== undefined ? { builderModel: parseOptionalModel("builder", data.builderModel, builderModels) } : {}),
    ...(data.builderEffort !== undefined ? { builderEffort: parseOptionalBuilderEffort(data.builderEffort) } : {})
  };
}

function writeJson(res: ServerResponse, response: JsonResponse): void {
  const body = JSON.stringify(response.body);
  res.writeHead(response.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function routeApprove(pathname: string): string | null {
  const match = pathname.match(/^\/api\/runs\/([^/]+)\/approve$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function routeEvents(pathname: string): string | null {
  const match = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.flushHeaders();
}

export function createHttpSseClient(res: ServerResponse): SseClient {
  let closed = false;
  // res.write does not throw synchronously on a dead socket; Node returns false and emits 'error'
  // asynchronously. Without a handler that error escalates to an uncaughtException, so latch the
  // client closed here to make future send()/end() no-op instead.
  res.once("error", () => {
    closed = true;
  });
  return {
    send(event, data, id) {
      if (closed) {
        return;
      }
      const idLine = id === undefined ? "" : `id: ${id}\n`;
      res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (closed) {
        return;
      }
      closed = true;
      res.end();
    },
    cleanup() {
      if (closed) {
        return;
      }
      closed = true;
      if (!res.writableEnded) {
        res.end();
      }
    }
  };
}

export function errorResponse(error: Error): JsonResponse {
  if (error instanceof PlanForgeError) {
    return {
      status: error.code === "E_PAYLOAD_TOO_LARGE" ? 413 : 400,
      body: { ok: false, code: error.code, message: error.message }
    };
  }
  return { status: 400, body: { ok: false, code: "E_BAD_REQUEST", message: error.message } };
}

function conversationErrorResponse(error: Error): JsonResponse {
  if (error instanceof PlanForgeError) {
    const statusByCode: Record<string, number> = {
      E_CONVERSATION_NOT_FOUND: 404,
      E_CONVERSATION_CORRUPT: 500,
      E_NO_LIVE_RUN: 409,
      E_APPROVAL_NOT_FOUND: 409,
      E_APPROVAL_PENDING: 409,
      E_SESSION_ALREADY_STARTED: 409,
      E_MCP_CONFIG_PROVIDER_MISSING: 500,
      E_PAYLOAD_TOO_LARGE: 413
    };
    return {
      status: statusByCode[error.code] ?? 400,
      body: { ok: false, code: error.code, message: error.message }
    };
  }
  return errorResponse(error);
}

function invalidConversationRequest(code: string, message: string): JsonResponse {
  return { status: 400, body: { ok: false, code, message } };
}

function routeConversationAction(pathname: string): { readonly id: string; readonly action: string } | null {
  const match = pathname.match(/^\/api\/conversations\/([^/]+)\/(transcript|messages|approve|stop|events|restore)$/);
  return match ? { id: match[1] ?? "", action: match[2] ?? "" } : null;
}

// The bare item route `/api/conversations/:id` (no action suffix) carries the PATCH (rename) and
// DELETE (archive) verbs. It is matched separately from the action route above.
function routeConversationItem(pathname: string): string | null {
  const match = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  return match ? match[1] ?? "" : null;
}

function parseConversationId(rawId: string): string | null {
  const parsed = conversationIdSchema.safeParse(rawId);
  return parsed.success ? parsed.data : null;
}

export type PlanForgeHttpHandlerInput = {
  readonly registry: PlanForgeRegistry;
  readonly runService: ChatRunService;
  readonly loopConfig?: PlanForgeToolLoopConfig;
  readonly store?: ConversationStore;
  readonly orchestrator?: ConversationOrchestrator;
  readonly staticRoot?: string;
  // Estate root, used to enumerate the allowed build targets surfaced at GET /api/config.
  readonly workspaceRoot?: string;
  // Live resolved port (ephemeral ports are only known after listen()), used to allow only this
  // server's localhost origins on state-changing routes (DNS-rebinding / cross-origin defense).
  readonly resolvedPort?: () => number;
};

// State-changing routes have no auth on this localhost orchestrator, so a malicious web page could
// drive them via DNS rebinding. A present, cross-origin Origin header is rejected; requests with no
// Origin (curl/CLI/same-process) and the SPA's same-origin fetches are allowed.
function forbiddenCrossOrigin(req: IncomingMessage): JsonResponse | null {
  const origin = headerValue(req.headers.origin);
  if (origin === undefined || origin.length === 0) {
    return null; // no Origin header (curl / CLI / same-process)
  }
  // Same-origin check: the page's Origin host must match the host this request was sent to.
  // Allows the SPA whether it is served on loopback or over the tailnet (`tailscale serve`),
  // while a DNS-rebinding page (Origin = attacker site, Host = 127.0.0.1/tailnet) fails the match.
  const host = headerValue(req.headers.host);
  let originHost: string | undefined;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = undefined;
  }
  if (host !== undefined && originHost === host) {
    return null;
  }
  return {
    status: 403,
    body: { ok: false, code: "E_FORBIDDEN_ORIGIN", message: "Cross-origin request rejected." }
  };
}

const staticContentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp"
};

function staticNotFound(): JsonResponse {
  return { status: 404, body: { ok: false, code: "E_NOT_FOUND", message: "Route not found." } };
}

function decodeStaticPathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function routePrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function resolveStaticCandidate(root: string, decodedPathname: string): string | null {
  const candidate = path.resolve(root, decodedPathname.replace(/^\/+/, ""));
  return containsPath(root, candidate) ? candidate : null;
}

function contentTypeFor(filePath: string): string {
  return staticContentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

type StaticWriteResult = "served" | "miss" | "rejected";

async function writeStaticFile(res: ServerResponse, rootRealPath: string, filePath: string): Promise<StaticWriteResult> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return "miss";
    }
    const fileRealPath = await realpath(filePath);
    if (!containsPath(rootRealPath, fileRealPath)) {
      return "rejected";
    }
    const body = await readFile(fileRealPath);
    res.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "content-length": body.byteLength
    });
    res.end(body);
    return "served";
  } catch {
    return "miss";
  }
}

async function tryStaticResponse(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  staticRoot: string | undefined
): Promise<boolean> {
  if (!staticRoot || req.method !== "GET") {
    return false;
  }
  const decodedPathname = decodeStaticPathname(url.pathname);
  if (!decodedPathname) {
    writeJson(res, staticNotFound());
    return true;
  }
  if (routePrefix(decodedPathname, "/api") || routePrefix(decodedPathname, "/mcp")) {
    return false;
  }

  const root = path.resolve(staticRoot);
  let rootRealPath: string;
  try {
    rootRealPath = await realpath(root);
  } catch {
    writeJson(res, staticNotFound());
    return true;
  }
  const candidate = resolveStaticCandidate(root, decodedPathname);
  if (!candidate) {
    writeJson(res, staticNotFound());
    return true;
  }
  const staticResult = await writeStaticFile(res, rootRealPath, candidate);
  if (staticResult === "served") {
    return true;
  }
  if (staticResult === "rejected") {
    writeJson(res, staticNotFound());
    return true;
  }
  if (path.extname(decodedPathname).length > 0) {
    writeJson(res, staticNotFound());
    return true;
  }
  const indexPath = path.join(root, "index.html");
  const indexResult = await writeStaticFile(res, rootRealPath, indexPath);
  if (indexResult === "served") {
    return true;
  }
  writeJson(res, staticNotFound());
  return true;
}

export function createPlanForgeHttpHandler(input: PlanForgeHttpHandlerInput): RequestListener {
  const registry = input.registry;
  const runService = input.runService;
  const store = input.store;
  const orchestrator = input.orchestrator;
  const staticRoot = input.staticRoot;
  const resolvedPort = input.resolvedPort;
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // State-changing verbs (POST/PATCH/DELETE) on /api/* are gated against a cross-origin Origin so
      // a DNS-rebinding page cannot rename/archive/create via the no-auth localhost orchestrator.
      if ((req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") && url.pathname.startsWith("/api/")) {
        const forbidden = forbiddenCrossOrigin(req);
        if (forbidden) {
          writeJson(res, forbidden);
          return;
        }
      }
      // GET /api/config surfaces the server-configured default build target + the allowlisted target
      // picker, so the UI can show which repo a conversation builds in and let a new conversation
      // choose one. Read-only; the allowlist itself is the security boundary (a disallowed target is
      // rejected at create time by the store).
      if (req.method === "GET" && url.pathname === "/api/config") {
        const allowedTargets = listAllowedTargetRepos(
          input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}
        ).map((target) => ({ path: target.path, label: target.label }));
        writeJson(res, {
          status: 200,
          body: {
            targetRepo: input.loopConfig?.targetRepo ?? null,
            allowedTargets,
            architectModels: input.loopConfig?.architectModels ?? parseArchitectModelAllowlist(undefined),
            builderModels: input.loopConfig?.builderModels ?? parseBuilderModelAllowlist(undefined),
            architectEfforts: ARCHITECT_EFFORTS,
            builderEfforts: BUILDER_EFFORTS
          }
        });
        return;
      }

      if (store && orchestrator && url.pathname === "/api/conversations") {
        try {
          if (req.method === "POST") {
            const parsed = createConversationInputSchema.safeParse((await readJson(req)) ?? {});
            if (!parsed.success) {
              writeJson(
                res,
                invalidConversationRequest(
                  "E_INVALID_CONVERSATION_REQUEST",
                  parsed.error.issues[0]?.message ?? "Invalid conversation request."
                )
              );
              return;
            }
            const conversation = await store.create({
              ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
              ...parseConversationRunControls(parsed.data, input.loopConfig)
            });
            writeJson(res, { status: 200, body: { id: conversation.id } });
            return;
          }
          if (req.method === "GET") {
            const includeArchived = url.searchParams.get("includeArchived") === "true";
            writeJson(res, {
              status: 200,
              body: { conversations: await store.list({ includeArchived }) }
            });
            return;
          }
        } catch (error) {
          writeJson(res, conversationErrorResponse(error instanceof Error ? error : new Error(String(error))));
          return;
        }
      }

      if (store && orchestrator) {
        const conversationRoute = routeConversationAction(url.pathname);
        if (conversationRoute) {
          const conversationId = parseConversationId(conversationRoute.id);
          if (!conversationId) {
            writeJson(
              res,
              invalidConversationRequest("E_INVALID_CONVERSATION_ID", "Conversation id must be a UUID.")
            );
            return;
          }
          try {
            if (conversationRoute.action === "transcript" && req.method === "GET") {
              const parsedAfterSeq = lastEventIdSchema.safeParse(url.searchParams.get("afterSeq") ?? undefined);
              if (!parsedAfterSeq.success) {
                writeJson(
                  res,
                  invalidConversationRequest("E_INVALID_CONVERSATION_TRANSCRIPT", "Invalid transcript query.")
                );
                return;
              }
              const entries = await store.readTranscript(conversationId, {
                ...(parsedAfterSeq.data === undefined ? {} : { afterSeq: parsedAfterSeq.data })
              });
              writeJson(res, { status: 200, body: { entries } });
              return;
            }

            if (conversationRoute.action === "events" && req.method === "GET") {
              // Browsers cannot set Last-Event-ID on a fresh EventSource, so the SPA passes its
              // resume point as ?afterSeq. The header still wins when present: it is the browser's
              // auto-reconnect watermark and is at least as current as the URL's query.
              const parsedLastEventId = lastEventIdSchema.safeParse(
                headerValue(req.headers["last-event-id"]) ?? url.searchParams.get("afterSeq") ?? undefined
              );
              if (!parsedLastEventId.success) {
                writeJson(
                  res,
                  invalidConversationRequest("E_INVALID_CONVERSATION_EVENTS", "Invalid conversation event subscription.")
                );
                return;
              }
              const conversation = await store.get(conversationId);
              if (!conversation) {
                writeJson(res, {
                  status: 404,
                  body: {
                    ok: false,
                    code: "E_CONVERSATION_NOT_FOUND",
                    message: `Conversation ${conversationId} was not found.`
                  }
                });
                return;
              }

              const client = createHttpSseClient(res);
              writeSseHeaders(res);
              let dispose: (() => void) | null = null;
              let closed = false;
              const onClose = () => {
                closed = true;
                if (dispose) {
                  dispose();
                  return;
                }
                client.cleanup();
              };
              req.once("close", onClose);
              try {
                dispose = await store.subscribe(conversationId, client, {
                  ...(parsedLastEventId.data === undefined ? {} : { lastEventId: parsedLastEventId.data })
                });
                if (closed) {
                  dispose();
                }
              } catch (error) {
                // An unrecoverable subscribe failure must not leave the browser on a silently dead
                // stream. Emit a distinct `stream_error` event (not `error`, which is a transcript
                // entry type the client also listens for) so the client can surface it and stop
                // reconnecting, then clean up.
                console.error(`Conversation ${conversationId} SSE subscribe failed:`, error);
                req.off("close", onClose);
                client.send("stream_error", {
                  ok: false,
                  code: error instanceof PlanForgeError ? error.code : "E_CONVERSATION_SUBSCRIBE_FAILED",
                  message: error instanceof Error ? error.message : String(error)
                });
                client.cleanup();
              }
              return;
            }

            const conversation = await store.get(conversationId);
            if (!conversation) {
              throw new PlanForgeError("E_CONVERSATION_NOT_FOUND", `Conversation ${conversationId} was not found.`);
            }

            if (conversationRoute.action === "messages" && req.method === "POST") {
              const parsed = messageInputSchema.safeParse(await readJson(req));
              if (!parsed.success) {
                writeJson(
                  res,
                  invalidConversationRequest(
                    "E_INVALID_CONVERSATION_MESSAGE",
                    parsed.error.issues[0]?.message ?? "Invalid message."
                  )
                );
                return;
              }
              await orchestrator.sendMessage(conversation.id, parsed.data.text);
              writeJson(res, { status: 200, body: { ok: true } });
              return;
            }

            if (conversationRoute.action === "approve" && req.method === "POST") {
              const parsed = conversationApprovalInputSchema.safeParse(await readJson(req));
              if (!parsed.success) {
                writeJson(
                  res,
                  invalidConversationRequest(
                    "E_INVALID_CONVERSATION_APPROVAL",
                    parsed.error.issues[0]?.message ?? "Invalid approval."
                  )
                );
                return;
              }
              orchestrator.approve(conversation.id, parsed.data.verdict, parsed.data.feedback);
              writeJson(res, { status: 200, body: { ok: true } });
              return;
            }

            if (conversationRoute.action === "stop" && req.method === "POST") {
              await orchestrator.stop(conversation.id);
              writeJson(res, { status: 200, body: { ok: true } });
              return;
            }

            if (conversationRoute.action === "restore" && req.method === "POST") {
              const restored = await store.setArchived(conversation.id, false);
              writeJson(res, { status: 200, body: { ok: true, conversation: restored } });
              return;
            }
          } catch (error) {
            writeJson(res, conversationErrorResponse(error instanceof Error ? error : new Error(String(error))));
            return;
          }
        }
      }

      if (store && orchestrator) {
        // The bare item route `/api/conversations/:id` carries rename (PATCH) and archive (DELETE).
        const itemId = routeConversationItem(url.pathname);
        if (itemId) {
          const conversationId = parseConversationId(itemId);
          if (!conversationId) {
            writeJson(
              res,
              invalidConversationRequest("E_INVALID_CONVERSATION_ID", "Conversation id must be a UUID.")
            );
            return;
          }
          try {
            if (req.method === "PATCH") {
              const parsed = patchConversationInputSchema.safeParse(await readJson(req));
              if (!parsed.success) {
                writeJson(
                  res,
                  invalidConversationRequest(
                    "E_INVALID_CONVERSATION_REQUEST",
                    parsed.error.issues[0]?.message ?? "Invalid conversation update request."
                  )
                );
                return;
              }
              // A retarget is rejected (404/409/400) by the store before any title change is applied,
              // so a started-conversation or disallowed-target PATCH never partially mutates.
              let conversation: Conversation | null = null;
              if (hasRunControlFields(parsed.data)) {
                conversation = await store.updateRunControls(
                  conversationId,
                  parseConversationRunControls(parsed.data, input.loopConfig)
                );
              }
              if (parsed.data.title !== undefined) {
                conversation = await store.rename(conversationId, parsed.data.title);
              }
              if (!conversation) {
                writeJson(
                  res,
                  invalidConversationRequest(
                    "E_INVALID_CONVERSATION_REQUEST",
                    "Provide a title, targetRepo, model, or effort value to update."
                  )
                );
                return;
              }
              writeJson(res, { status: 200, body: { ok: true, conversation } });
              return;
            }
            if (req.method === "DELETE") {
              // Soft delete: archive (hide from the default list) rather than destroy the transcript.
              // The conversation stays on disk and is restorable via POST /restore.
              const conversation = await store.setArchived(conversationId, true);
              writeJson(res, { status: 200, body: { ok: true, archived: true, conversation } });
              return;
            }
          } catch (error) {
            writeJson(res, conversationErrorResponse(error instanceof Error ? error : new Error(String(error))));
            return;
          }
        }
      }

      const eventsRunId = routeEvents(url.pathname);
      if (req.method === "GET" && eventsRunId) {
        const parsedRoute = runIdParamSchema.safeParse({ runId: eventsRunId });
        const parsedLastEventId = lastEventIdSchema.safeParse(headerValue(req.headers["last-event-id"]));
        if (!parsedRoute.success || !parsedLastEventId.success) {
          writeJson(res, {
            status: 400,
            body: { ok: false, code: "E_INVALID_RUN_EVENTS", message: "Invalid run event subscription." }
          });
          return;
        }
        const run = runService.get(parsedRoute.data.runId);
        if (!run) {
          writeJson(res, { status: 404, body: { ok: false, code: "E_RUN_NOT_FOUND", message: "Run not found." } });
          return;
        }
        writeSseHeaders(res);
        const dispose = runService.subscribe(run, createHttpSseClient(res), {
          ...(parsedLastEventId.data === undefined ? {} : { lastEventId: parsedLastEventId.data })
        });
        req.once("close", dispose);
        return;
      }
      const approveRunId = routeApprove(url.pathname);
      if (req.method === "POST" && approveRunId) {
        const parsed = approvalInputSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          writeJson(res, {
            status: 400,
            body: { ok: false, code: "E_INVALID_APPROVAL", message: parsed.error.issues[0]?.message ?? "Invalid approval." }
          });
          return;
        }
        const result = registry.resolveApproval({
          runId: approveRunId,
          verdict: parsed.data.verdict,
          ...(parsed.data.reviewer ? { reviewer: parsed.data.reviewer } : {}),
          ...(parsed.data.feedback ? { feedback: parsed.data.feedback } : {})
        });
        writeJson(res, { status: 200, body: { ok: true, runId: result.runId, verdict: result.verdict } });
        return;
      }
      if (await tryStaticResponse(req, res, url, staticRoot)) {
        return;
      }
      writeJson(res, { status: 404, body: { ok: false, code: "E_NOT_FOUND", message: "Route not found." } });
    })().catch((error: Error) => {
      writeJson(res, errorResponse(error));
    });
  };
}
