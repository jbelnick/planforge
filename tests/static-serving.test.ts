import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPlanForgeStaticRoot, listenPlanForgeServer, type ListeningPlanForgeServer } from "../src/start-server";

const cwd = path.resolve(import.meta.dirname, "..");

let tempRoots: string[] = [];
let servers: ListeningPlanForgeServer[] = [];

async function closeServer(server: ListeningPlanForgeServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "planforge-static-"));
  tempRoots.push(root);
  return root;
}

async function createStaticRoot(): Promise<{ readonly root: string; readonly indexHtml: string }> {
  const root = await makeTempRoot();
  const staticRoot = path.join(root, "dist");
  await mkdir(path.join(staticRoot, "assets"), { recursive: true });
  const indexHtml = "<!doctype html><div id=\"root\">PlanForge chat pane</div>";
  await writeFile(path.join(staticRoot, "index.html"), indexHtml, "utf8");
  await writeFile(path.join(staticRoot, "assets", "app.css"), ".app{color:white}", "utf8");
  await writeFile(path.join(staticRoot, "assets", "space file.css"), ".space{color:white}", "utf8");
  await writeFile(path.join(root, "secret.txt"), "outside secret", "utf8");
  await symlink(path.join(root, "secret.txt"), path.join(staticRoot, "assets", "secret-link.txt"));
  return { root: staticRoot, indexHtml };
}

async function listenWithRuntime(input: { readonly staticRoot?: string } = {}): Promise<ListeningPlanForgeServer> {
  const root = await makeTempRoot();
  const targetRepo = path.join(root, "projects", "products", "target");
  await mkdir(path.join(targetRepo, ".git"), { recursive: true });
  const server = await listenPlanForgeServer({
    cwd,
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    env: {
      PLANFORGE_PORT: "0",
      PLANFORGE_TARGET_REPO: targetRepo,
      PLANFORGE_RUNTIME_ROOT: path.join(root, "runtime")
    },
    ...(input.staticRoot ? { staticRoot: input.staticRoot } : {})
  });
  servers.push(server);
  return server;
}

function baseUrl(server: ListeningPlanForgeServer): string {
  return `http://${server.host}:${server.port}`;
}

afterEach(async () => {
  const closing = servers.map(closeServer);
  servers = [];
  await Promise.all(closing);
  const roots = tempRoots;
  tempRoots = [];
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("static serving", () => {
  it("serves real static assets and falls back to index.html for app routes", async () => {
    const staticRoot = await createStaticRoot();
    const server = await listenWithRuntime({ staticRoot: staticRoot.root });

    const css = await fetch(`${baseUrl(server)}/assets/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe(".app{color:white}");

    const encodedCss = await fetch(`${baseUrl(server)}/assets/space%20file.css`);
    expect(encodedCss.status).toBe(200);
    expect(await encodedCss.text()).toBe(".space{color:white}");

    const root = await fetch(`${baseUrl(server)}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toBe(staticRoot.indexHtml);

    const route = await fetch(`${baseUrl(server)}/c/abc`);
    expect(route.status).toBe(200);
    expect(await route.text()).toBe(staticRoot.indexHtml);
  });

  it("keeps missing assets and unknown api routes as JSON 404s", async () => {
    const staticRoot = await createStaticRoot();
    const server = await listenWithRuntime({ staticRoot: staticRoot.root });

    const missingAsset = await fetch(`${baseUrl(server)}/assets/missing.js`);
    expect(missingAsset.status).toBe(404);
    await expect(missingAsset.json()).resolves.toMatchObject({ ok: false, code: "E_NOT_FOUND" });

    const missingApi = await fetch(`${baseUrl(server)}/api/missing`);
    expect(missingApi.status).toBe(404);
    await expect(missingApi.json()).resolves.toMatchObject({ ok: false, code: "E_NOT_FOUND" });
  });

  it("rejects static traversal and preserves the no-static-root 404 contract", async () => {
    const staticRoot = await createStaticRoot();
    const server = await listenWithRuntime({ staticRoot: staticRoot.root });

    const traversal = await fetch(`${baseUrl(server)}/..%2Fsecret.txt`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain("outside secret");

    const symlinkEscape = await fetch(`${baseUrl(server)}/assets/secret-link.txt`);
    expect(symlinkEscape.status).toBe(404);
    expect(await symlinkEscape.text()).not.toContain("outside secret");

    const noRootServer = await listenWithRuntime();
    const noRootMissing = await fetch(`${baseUrl(noRootServer)}/missing`);
    expect(noRootMissing.status).toBe(404);
    await expect(noRootMissing.json()).resolves.toMatchObject({ ok: false, code: "E_NOT_FOUND" });
  });

  it("resolves the production static root from the module path, not the process cwd", () => {
    const moduleUrl = pathToFileURL(path.join(cwd, "src", "start-server.ts")).href;
    expect(defaultPlanForgeStaticRoot(moduleUrl)).toBe(path.join(cwd, "dist"));
  });
});
