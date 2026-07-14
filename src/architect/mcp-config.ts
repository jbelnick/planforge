import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type PlanForgeMcpConfigInput = {
  readonly runtimeRoot: string;
  readonly runId: string;
  readonly host: string;
  readonly port: number;
};

export type PlanForgeMcpConfig = {
  readonly mcpServers: {
    readonly planforge: {
      readonly type: "http";
      readonly url: string;
    };
  };
};

export async function writePlanForgeMcpConfig(input: PlanForgeMcpConfigInput): Promise<string> {
  const configPath = path.join(input.runtimeRoot, input.runId, ".mcp.json");
  const config: PlanForgeMcpConfig = {
    mcpServers: {
      planforge: {
        type: "http",
        // The runId query param lets the server key this session's transport to the run, so the
        // orchestrator can close it at conversation teardown even when the client never DELETEs.
        url: `http://${input.host}:${input.port}/mcp?runId=${encodeURIComponent(input.runId)}`
      }
    }
  };
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600);
  return configPath;
}
