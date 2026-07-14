import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotifyHook } from "../src/notify-hook";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-notify-hook-"));
  tempDirs.push(root);
  return root;
}

async function waitForLog(logs: readonly string[], needle: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (logs.some((line) => line.includes(needle))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for notify log: ${needle}`);
}

describe("notify hook", () => {
  it("runs the command with JSON stdin and isolates nonzero exits", async () => {
    const root = await tempRoot();
    const outputPath = path.join(root, "payload.json");
    const scriptPath = path.join(root, "notify-fail.cjs");
    await writeFile(
      scriptPath,
      [
        "let body = '';",
        "process.stdin.on('data', (chunk) => { body += chunk; });",
        `process.stdin.on('end', () => { require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, body); process.exit(7); });`
      ].join("\n"),
      "utf8"
    );
    const logs: string[] = [];
    const hook = createNotifyHook({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      publicUrl: "https://planforge.example/base/",
      localOrigin: () => "http://127.0.0.1:4317",
      log: (message) => logs.push(message)
    });
    expect(hook).not.toBeNull();

    hook?.({
      event: "plan_awaiting_approval",
      conversationId: "conversation one",
      title: "Needs approval",
      state: "awaiting_approval"
    });

    await waitForLog(logs, "code=7");
    const payload = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    expect(payload).toEqual({
      event: "plan_awaiting_approval",
      conversationId: "conversation one",
      title: "Needs approval",
      state: "awaiting_approval",
      url: "https://planforge.example/base/conversations/conversation%20one"
    });
  });

  it("times out slow commands without throwing or waiting on the loop", async () => {
    const root = await tempRoot();
    const scriptPath = path.join(root, "notify-slow.cjs");
    await writeFile(scriptPath, "setTimeout(() => {}, 1000);", "utf8");
    const logs: string[] = [];
    const hook = createNotifyHook({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      localOrigin: () => "http://127.0.0.1:4317",
      timeoutMs: 25,
      log: (message) => logs.push(message)
    });
    const started = Date.now();

    expect(() =>
      hook?.({
        event: "cycle_complete",
        conversationId: "conversation-two",
        title: "Done",
        state: "fail"
      })
    ).not.toThrow();

    expect(Date.now() - started).toBeLessThan(200);
    await waitForLog(logs, "timed out after 25ms");
  });

  it("is fully off when the command is unset", () => {
    const log = vi.fn();
    expect(createNotifyHook({ command: null, localOrigin: () => "http://127.0.0.1:4317", log })).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});
