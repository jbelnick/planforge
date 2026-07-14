import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultGitRunner } from "../src/builder/codex-driver";

// The shared runner does `await import("node:child_process")` per call, so mocking execFile here
// lets us assert the argv + maxBuffer it threads, without shelling out to git. Only this file's
// runner under test touches child_process, so the file-scoped mock stays isolated.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        callback(null, { stdout: "stub-stdout", stderr: "" });
        return undefined;
      }
    )
  };
});

type ExecFileOptions = { readonly env?: NodeJS.ProcessEnv; readonly maxBuffer?: number };

const execFileMock = vi.mocked(execFile);

function lastCall(): { readonly file: string; readonly args: readonly string[]; readonly options: ExecFileOptions } {
  const call = execFileMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected execFile to have been called.");
  }
  return { file: call[0] as string, args: call[1] as readonly string[], options: call[2] as ExecFileOptions };
}

afterEach(() => {
  execFileMock.mockClear();
});

describe("shared default git runner", () => {
  it("threads argv and LC_ALL/LANG=C with no maxBuffer when unset", async () => {
    const runner = createDefaultGitRunner();
    const result = await runner(["-C", "/repo", "ls-files"]);

    expect(result).toEqual({ stdout: "stub-stdout", stderr: "" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const call = lastCall();
    expect(call.file).toBe("git");
    expect(call.args).toEqual(["-C", "/repo", "ls-files"]);
    expect(call.options.env).toMatchObject({ LC_ALL: "C", LANG: "C" });
    expect(call.options.maxBuffer).toBeUndefined();
  });

  it("threads the configured maxBuffer through to execFile", async () => {
    const maxBufferBytes = 32 * 1024 * 1024;
    await createDefaultGitRunner({ maxBufferBytes })(["-C", "/repo", "show", "HEAD:big-file"]);

    const call = lastCall();
    expect(call.args).toEqual(["-C", "/repo", "show", "HEAD:big-file"]);
    expect(call.options.maxBuffer).toBe(maxBufferBytes);
  });

  it("two runners with the same options issue identical execFile calls", async () => {
    await createDefaultGitRunner({ maxBufferBytes: 1024 })(["-C", "/repo", "rev-parse", "HEAD"]);
    const first = lastCall();
    await createDefaultGitRunner({ maxBufferBytes: 1024 })(["-C", "/repo", "rev-parse", "HEAD"]);
    const second = lastCall();

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(first.file).toBe(second.file);
    expect(first.args).toEqual(second.args);
    expect(first.options.maxBuffer).toBe(second.options.maxBuffer);
    expect(first.options.env).toEqual(second.options.env);
  });
});
