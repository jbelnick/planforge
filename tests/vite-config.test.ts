import { describe, expect, it } from "vitest";
import config from "../vite.config";
import { DEFAULT_PLANFORGE_PORT } from "../src/config";

describe("PlanForge Vite config", () => {
  it("vitest serializes heavy integration files with a longer timeout", () => {
    if (typeof config === "function") {
      throw new Error("Expected static Vite config.");
    }

    expect(config.test?.fileParallelism).toBe(false);
    expect(config.test?.testTimeout).toBeGreaterThanOrEqual(20_000);
  });

  it("vite proxy includes api and mcp routes", () => {
    if (typeof config === "function") {
      throw new Error("Expected static Vite config.");
    }

    expect(config.server?.proxy).toMatchObject({
      "/api": { target: `http://127.0.0.1:${DEFAULT_PLANFORGE_PORT}` },
      "/mcp": { target: `http://127.0.0.1:${DEFAULT_PLANFORGE_PORT}` }
    });
  });
});
