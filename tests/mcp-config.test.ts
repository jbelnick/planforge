import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writePlanForgeMcpConfig } from "../src/architect/mcp-config";
import { listenPlanForgeServer } from "../src/start-server";

const tempDirs: string[] = [];

const mcpConfigSchema = z.object({
  mcpServers: z.object({
    planforge: z.object({
      type: z.literal("http"),
      url: z.string().url()
    })
  })
});

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempRuntimeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-mcp-config-"));
  tempDirs.push(root);
  return path.join(root, "runtime");
}

describe("PlanForge Claude MCP config", () => {
  it("writes resolved-port http config and the SDK lists PlanForge tools", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    const server = await listenPlanForgeServer({
      port: 0,
      loopConfig: {
        targetRepo: "/tmp/fixture",
        runtimeRoot,
        env: { PATH: "/usr/bin" },
        verifierCommands: [{ name: "fixture verifier", command: "npm test" }]
      }
    });
    try {
      const configPath = await writePlanForgeMcpConfig({
        runtimeRoot,
        runId: "run-mcp-config",
        host: server.host,
        port: server.port
      });
      const config = mcpConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));

      expect(config.mcpServers.planforge).toEqual({
        type: "http",
        url: `http://127.0.0.1:${server.port}/mcp?runId=run-mcp-config`
      });

      const client = new Client({ name: "planforge-mcp-config-test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(config.mcpServers.planforge.url)));
      const tools = await client.listTools();
      await client.close();

      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "handoff_to_codex",
        "propose_plan",
        "read_repo_file",
        "sign_off"
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
