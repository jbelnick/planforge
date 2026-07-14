import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodTypeAny } from "zod";
import { PlanForgeError } from "./errors";
import type { JsonValue } from "./shared/json";
import { createPlanForgeToolHandlers, type PlanForgeToolHandlerInput } from "./tools";
import {
  handoffToCodexInputSchema,
  handoffToCodexOutputSchema,
  proposePlanInputSchema,
  readRepoFileInputSchema,
  signOffInputSchema
} from "./tools";

function textResult(value: object) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value)
      }
    ]
  };
}

async function toolResult(value: Promise<object>, outputSchema?: ZodTypeAny) {
  try {
    const resolved = await value;
    const base = textResult(resolved);
    if (!outputSchema) {
      return base;
    }
    // A tool that declares an outputSchema must return structuredContent matching it
    // exactly, or the MCP SDK rejects the result with -32602. Parse strips fields that
    // are not in the schema (e.g. the server-only branch/worktreePath on the handoff).
    return { ...base, structuredContent: outputSchema.parse(resolved) as Record<string, unknown> };
  } catch (error) {
    if (error instanceof PlanForgeError) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    throw error;
  }
}

export function createPlanForgeMcpServer(input: PlanForgeToolHandlerInput) {
  const handlers = createPlanForgeToolHandlers(input);
  const server = new McpServer(
    { name: "planforge", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "propose_plan",
    {
      description: "Propose a plan and block until the human approves or requests changes.",
      inputSchema: proposePlanInputSchema.shape
    },
    async (args) => toolResult(handlers.propose_plan(args))
  );

  server.registerTool(
    "read_repo_file",
    {
      description: "Read a git-tracked file from the target repo to inform planning.",
      inputSchema: readRepoFileInputSchema.shape
    },
    async (args) => toolResult(handlers.read_repo_file(args))
  );

  server.registerTool(
    "handoff_to_codex",
    {
      description: "Run Codex on the approved handoff and return independent verifier results.",
      inputSchema: handoffToCodexInputSchema.shape,
      outputSchema: handoffToCodexOutputSchema.shape
    },
    async (args) => toolResult(handlers.handoff_to_codex(args), handoffToCodexOutputSchema)
  );

  server.registerTool(
    "sign_off",
    {
      description: "Record architect sign-off after all verifier results pass.",
      inputSchema: signOffInputSchema.shape
    },
    // The SDK types args from the zod shape, so an optional field arrives as `boolean | undefined`,
    // which does not fit JsonValue. The handler re-validates this inbound tool call regardless; pass
    // it through the JsonValue boundary as the other tool registrations do.
    async (args) => toolResult(handlers.sign_off(args as JsonValue))
  );

  return server;
}
