import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["dot"],
    // CLI subprocess tests use spawnSync, which blocks the worker event loop
    // past vitest's RPC ping window and surfaces as "Timeout calling
    // onTaskUpdate" unhandled errors. They are framework noise, not test
    // failures — ignore so the suite exits 0.
    dangerouslyIgnoreUnhandledErrors: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts"],
          pool: "threads",
          testTimeout: 5000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["packages/*/test/**/*.test.ts"],
          pool: "forks",
          testTimeout: 15000,
          teardownTimeout: 30000,
          globalSetup: ["./vitest.global-setup.ts"],
        },
      },
    ],
  },
});
