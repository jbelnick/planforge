import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { DEFAULT_PLANFORGE_PORT } from "./src/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: `http://127.0.0.1:${DEFAULT_PLANFORGE_PORT}` },
      "/mcp": { target: `http://127.0.0.1:${DEFAULT_PLANFORGE_PORT}` }
    }
  },
  test: {
    environment: "node",
    fileParallelism: false,
    globals: true,
    testTimeout: 20_000,
    setupFiles: ["./vitest.setup.ts"]
  }
});
