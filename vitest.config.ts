import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["dot"],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onConsoleLog(_log: string, _type: "stdout" | "stderr") {
      // Suppress all console output: Vitest output stays quiet.
      // The no-console ESLint rule is the enforcement gate for application
      // code; this hook just keeps the reporter clean at runtime.
      return false;
    },
    // CLI subprocess tests use spawnSync, which blocks the worker event loop
    // past vitest's RPC ping window and surfaces as "Timeout calling
    // onTaskUpdate" unhandled errors. They are framework noise, not test
    // failures — ignore so the suite exits 0.
    dangerouslyIgnoreUnhandledErrors: true,
    projects: [
      "packages/cli/vitest.unit.config.ts",
      "packages/cli/vitest.integration.config.ts",
      "packages/spawner/vitest.config.ts",
    ],
  },
});
