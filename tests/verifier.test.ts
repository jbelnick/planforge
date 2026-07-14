import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanForgeRegistry } from "../src/registry";
import { runAcceptanceVerifiers, type VerifierCommandRunner } from "../src/verifier";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempWorktree() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planforge-verifier-"));
  tempDirs.push(dir);
  return dir;
}

describe("Verifier runner", () => {
  it("verifier ignores builder self-report", async () => {
    const worktreePath = await tempWorktree();
    await writeFile(path.join(worktreePath, "STATUS.md"), "- claimed verdict: pass\n", "utf8");
    const runner: VerifierCommandRunner = async (_command, cwd) => {
      expect(cwd).toBe(worktreePath);
      return { exitCode: 7, stdout: "builder said pass", stderr: "real verifier failed" };
    };

    await expect(
      runAcceptanceVerifiers({
        worktreePath,
        commands: [{ name: "real verifier", command: "npm test" }],
        runner
      })
    ).resolves.toEqual([
      {
        name: "real verifier",
        status: "fail",
        exitCode: 7,
        output: "builder said pass\nreal verifier failed"
      }
    ]);
  });

  it("fail before / pass after", async () => {
    const worktreePath = await tempWorktree();
    const command = "node -e \"process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)\"";

    const before = await runAcceptanceVerifiers({
      worktreePath,
      commands: [{ name: "fixture verifier", command }]
    });
    await writeFile(path.join(worktreePath, "fixed.txt"), "fixed\n", "utf8");
    const after = await runAcceptanceVerifiers({
      worktreePath,
      commands: [{ name: "fixture verifier", command }]
    });

    expect(before[0]?.status).toBe("fail");
    expect(after[0]?.status).toBe("pass");
  });

  it("caps captured output at head+tail 64KiB total with an elision marker in the middle", async () => {
    const worktreePath = await tempWorktree();
    // Emit 192KiB of stdout in three distinct 64KiB bands so the kept head (A), the elided middle
    // (B), and the kept rolling tail (C) are distinguishable. The capture must keep the first 32KiB
    // and the last 32KiB and replace everything between with one marker, regardless of how the pipe
    // chunks the stream.
    const command = "node -e \"const w=(c)=>process.stdout.write(c.repeat(65536));w('A');w('B');w('C')\"";
    const results = await runAcceptanceVerifiers({
      worktreePath,
      commands: [{ name: "chatty verifier", command }]
    });

    const output = results[0]?.output ?? "";
    expect(results[0]?.status).toBe("pass");
    expect(output.startsWith("A".repeat(32 * 1024))).toBe(true);
    expect(output.endsWith("C".repeat(32 * 1024))).toBe(true);
    expect(output).toContain("... [verifier output elided: 131072 characters omitted] ...");
    // Head + marker + tail: bounded at ~64KiB total, never the raw 192KiB blob.
    expect(output.length).toBeLessThan(64 * 1024 + 128);
  });

  it("leaves output under the capture limit untouched (no marker)", async () => {
    const worktreePath = await tempWorktree();
    const results = await runAcceptanceVerifiers({
      worktreePath,
      commands: [{ name: "quiet verifier", command: "node -e \"process.stdout.write('small output')\"" }]
    });

    expect(results[0]?.output).toBe("small output");
  });

  it("kills and reports blocked when a verifier command exceeds its wall", async () => {
    const worktreePath = await tempWorktree();
    // A command that would otherwise hang ~30s; the 300ms wall must group-kill it and report blocked
    // (exitCode null) so the loop is released rather than wedged.
    const results = await runAcceptanceVerifiers({
      worktreePath,
      commands: [{ name: "hanging verifier", command: 'node -e "setTimeout(() => {}, 30000)"' }],
      timeoutMs: 300
    });

    expect(results[0]?.status).toBe("blocked");
    expect(results[0]?.exitCode).toBeNull();
    expect(results[0]?.output).toContain("exceeded the 300ms wall");
  });

  it("lets a command that finishes under its wall pass normally", async () => {
    const worktreePath = await tempWorktree();
    const results = await runAcceptanceVerifiers({
      worktreePath,
      commands: [{ name: "fast verifier", command: 'node -e "process.exit(0)"' }],
      timeoutMs: 5_000
    });

    expect(results[0]?.status).toBe("pass");
    expect(results[0]?.exitCode).toBe(0);
  });

  it("sign_off blocked unless all pass", async () => {
    const verifierResults = new Map([
      ["run-fail", [{ name: "verifier", status: "fail" as const, exitCode: 1 }]],
      ["run-blocked", [{ name: "verifier", status: "blocked" as const }]],
      ["run-pass", [{ name: "verifier", status: "pass" as const, exitCode: 0 }]]
    ]);
    const registry = createPlanForgeRegistry({
      runBuilder: async (handoff) => ({
        status: handoff.runId === "run-pass" ? "pass" : "fail",
        verifierResults: verifierResults.get(handoff.runId) ?? []
      })
    });

    await registry.handoffToCodex({
      runId: "run-fail",
      project: "fixture",
      objective: "Fix",
      context: "Temp",
      constraints: "None",
      verification: ["npm test"],
      stop_conditions: ["Stop"]
    });
    expect(() => registry.signOff({ runId: "run-fail", verdict: "pass", grade: "Looks good" })).toThrow(
      /requires every verifier result/
    );

    await registry.handoffToCodex({
      runId: "run-blocked",
      project: "fixture",
      objective: "Fix",
      context: "Temp",
      constraints: "None",
      verification: ["npm test"],
      stop_conditions: ["Stop"]
    });
    expect(() => registry.signOff({ runId: "run-blocked", verdict: "pass", grade: "Looks good" })).toThrow(
      /requires every verifier result/
    );

    await registry.handoffToCodex({
      runId: "run-pass",
      project: "fixture",
      objective: "Fix",
      context: "Temp",
      constraints: "None",
      verification: ["npm test"],
      stop_conditions: ["Stop"]
    });
    expect(registry.signOff({ runId: "run-pass", verdict: "pass", grade: "Looks good" })).toEqual({
      runId: "run-pass",
      status: "signed_off",
      grade: "Looks good"
    });
  });
});
