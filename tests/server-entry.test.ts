import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanForgeHttpHandler } from "../src/http-server";
import { createChatRunService } from "../src/run-service";
import { createPlanForgeRegistry } from "../src/registry";
import { createPlanForgeSingleProcessHandler } from "../src/server";
import { DEFAULT_PLANFORGE_PORT } from "../src/config";
import { createPlanForgeServer, planForgePortFromEnv } from "../src/start-server";

const servers: Server[] = [];
const tempDirs: string[] = [];

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
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempRuntimeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-server-entry-"));
  tempDirs.push(root);
  return path.join(root, "runtime");
}

async function tempAllowlistedTarget(): Promise<{ readonly workspaceRoot: string; readonly targetRepo: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "planforge-server-entry-workspace-"));
  tempDirs.push(workspaceRoot);
  const targetRepo = path.join(workspaceRoot, "projects", "products", "target");
  await mkdir(path.join(targetRepo, ".git"), { recursive: true });
  return { workspaceRoot, targetRepo };
}

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

describe("PlanForge server entrypoint", () => {
  it("server listens and serves routes", async () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const baseUrl = await listen(createPlanForgeSingleProcessHandler({ registry, runService }));

    const pending = registry.proposePlan({
      runId: "run-listen",
      title: "Listening server",
      plan: "Approve through the route."
    });

    const approve = await fetch(`${baseUrl}/api/runs/run-listen/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "approved" })
    });
    await expect(approve.json()).resolves.toMatchObject({ ok: true, runId: "run-listen" });
    await expect(pending).resolves.toMatchObject({ runId: "run-listen", verdict: "approved" });

    const missing = await fetch(`${baseUrl}/missing`);
    await expect(missing.json()).resolves.toMatchObject({ ok: false, code: "E_NOT_FOUND" });
    expect(missing.status).toBe(404);
  });

  it("start entrypoint constructs shared registry and run-service", async () => {
    const runtimeRoot = await tempRuntimeRoot();
    const target = await tempAllowlistedTarget();
    const created = createPlanForgeServer({
      workspaceRoot: target.workspaceRoot,
      env: { PLANFORGE_PORT: "0", PLANFORGE_TARGET_REPO: target.targetRepo, PLANFORGE_RUNTIME_ROOT: runtimeRoot }
    });

    expect(created.host).toBe("127.0.0.1");
    expect(created.port).toBe(0);
    expect(created.registry.pendingApprovalsCount()).toBe(0);
    expect(created.runService.list()).toEqual([]);
    expect(created.loopConfig.targetRepo).toBe(target.targetRepo);
    expect(created.loopConfig.runtimeRoot).toBe(runtimeRoot);
    expect(created.handler).toBeTypeOf("function");
    expect(planForgePortFromEnv({ PLANFORGE_PORT: String(DEFAULT_PLANFORGE_PORT) })).toBe(DEFAULT_PLANFORGE_PORT);
  });

  it("http handler requires the shared run-service dependency", () => {
    const registry = createPlanForgeRegistry();
    const runService = createChatRunService();
    const handler = createPlanForgeHttpHandler({ registry, runService });

    expect(handler).toBeTypeOf("function");
  });
});
