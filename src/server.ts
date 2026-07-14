import { randomUUID } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PlanForgeError } from "./errors";
import type { ChatRunService } from "./run-service";
import { createPlanForgeHttpHandler } from "./http-server";
import { createPlanForgeMcpServer } from "./mcp-server";
import type { PlanForgeRegistry } from "./registry";
import { headerValue, readJson } from "./shared/http";
import type { PlanForgeToolLoopConfig } from "./tools";
import type { ConversationOrchestrator, McpSessionStore } from "./conversation-orchestrator";
import type { ConversationStore } from "./conversation-store";

function writeText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message)
  });
  res.end(message);
}

export type PlanForgeSingleProcessHandlerInput = {
  readonly registry: PlanForgeRegistry;
  readonly runService: ChatRunService;
  readonly loopConfig?: PlanForgeToolLoopConfig;
  readonly store?: ConversationStore;
  readonly orchestrator?: ConversationOrchestrator;
  readonly staticRoot?: string;
  // Shared runId -> resolved targetRepo map (same instance the orchestrator publishes to), passed to
  // the read_repo_file MCP tool so it reads from the conversation's target.
  readonly targetRepoStore?: Map<string, string>;
  // Estate root used to enumerate allowed build targets for the UI picker (GET /api/config).
  readonly workspaceRoot?: string;
  // Live resolved port (ephemeral ports are only known after listen()), used to pin the MCP
  // transport's DNS-rebinding allowlist to this localhost origin.
  readonly resolvedPort?: () => number;
  // Shared runId -> live MCP transports map (same instance the orchestrator closes at teardown).
  // Sessions initialized with a ?runId query param register here so reaped architect sessions do
  // not leak transports for process life when the client never sends the spec DELETE.
  readonly mcpSessions?: McpSessionStore;
};

export function createPlanForgeSingleProcessHandler(input: PlanForgeSingleProcessHandlerInput): RequestListener {
  const webHandler = createPlanForgeHttpHandler(input);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const mcpSessions = input.mcpSessions;

  function registerRunSession(runId: string, transport: StreamableHTTPServerTransport): void {
    if (!mcpSessions) {
      return;
    }
    const sessions = mcpSessions.get(runId) ?? new Set();
    sessions.add(transport);
    mcpSessions.set(runId, sessions);
  }

  // Teardown/initialize race guard: teardown cancels the run (terminal status) synchronously BEFORE
  // draining its transports, so a run that exists in a terminal state means the drain already ran —
  // a session registered after it would leak for process life (nothing ever closes it again). A
  // runId the run service does not know is left alone: it was never orchestrated, so there is no
  // teardown to race (and direct SDK sessions against a hand-written config keep working).
  function runTornDown(runId: string): boolean {
    const run = input.runService.get(runId);
    return run !== null && input.runService.isTerminal(run.status);
  }

  function releaseRunSession(runId: string, transport: StreamableHTTPServerTransport): void {
    const sessions = mcpSessions?.get(runId);
    if (!sessions) {
      return;
    }
    sessions.delete(transport);
    if (sessions.size === 0) {
      mcpSessions?.delete(runId);
    }
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const sessionId = headerValue(req.headers["mcp-session-id"]);
    if (req.method === "GET" || req.method === "DELETE") {
      // The SDK transport serves both natively: GET opens the session's standalone SSE stream
      // (resumption), DELETE is the spec's session termination (transport.close() fires onclose,
      // which reaps the map entry). Both are session-scoped, so an unknown session stops here.
      if (!sessionId || !transports.has(sessionId)) {
        writeText(res, 400, "Invalid or missing MCP session ID.");
        return;
      }
      await transports.get(sessionId)?.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      writeText(res, 405, "Method not allowed.");
      return;
    }

    const body = await readJson(req);
    const existing = sessionId ? transports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res, body);
      return;
    }

    // DNS-rebinding protection: a no-auth localhost server that spawns code-writers must reject
    // requests a remote page rebinds onto it. Pin Host/Origin to this server's localhost identity.
    const port = input.resolvedPort?.();
    const allowedHosts = port === undefined ? undefined : [`127.0.0.1:${port}`, `localhost:${port}`];
    const allowedOrigins = port === undefined ? undefined : [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

    // The per-run architect .mcp.json carries ?runId=<runId>, keying this session's transport to
    // its run so the orchestrator can close it at conversation teardown.
    const runId = url.searchParams.get("runId");
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        // An initialize that lands after the run was torn down must not be retained: skip BOTH maps
        // so the in-flight initialize still gets its response (closing here would detach the MCP
        // server's onmessage and hang the request) while follow-up requests see an unknown session
        // id and the unreferenced transport is simply dropped.
        if (runId && runTornDown(runId)) {
          return;
        }
        transports.set(newSessionId, transport);
        if (runId) {
          registerRunSession(runId, transport);
        }
      },
      ...(allowedHosts ? { enableDnsRebindingProtection: true, allowedHosts, allowedOrigins } : {})
    });
    transport.onclose = () => {
      const closedSessionId = transport.sessionId;
      if (closedSessionId) {
        transports.delete(closedSessionId);
      }
      if (runId) {
        releaseRunSession(runId, transport);
      }
    };

    const mcpServer = createPlanForgeMcpServer(
      input.loopConfig
        ? { registry: input.registry, runService: input.runService, loopConfig: input.loopConfig, ...(input.targetRepoStore ? { targetRepoStore: input.targetRepoStore } : {}) }
        : { registry: input.registry }
    );
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/mcp") {
      void handleMcp(req, res, url).catch((error: Error) => {
        if (error instanceof PlanForgeError && error.code === "E_PAYLOAD_TOO_LARGE") {
          writeText(res, 413, error.message);
          return;
        }
        writeText(res, 500, error.message);
      });
      return;
    }
    webHandler(req, res);
  };
}
