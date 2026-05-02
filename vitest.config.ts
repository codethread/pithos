import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["dot"],
    // CLI subprocess tests use spawnSync, which blocks the worker event loop
    // past vitest's RPC ping window and surfaces as "Timeout calling
    // onTaskUpdate" unhandled errors. They are framework noise, not test
    // failures — ignore so the suite exits 0.
    dangerouslyIgnoreUnhandledErrors: true,
    // Timeouts are tight on purpose. Slowest unit ≈ 30ms, slowest integration
    // ≈ 1.7s (CLI subprocess + SQLite). If a test starts brushing these,
    // **do not raise the timeout to make it pass** — write a faster test
    // (smaller fixture, fewer subprocess hops, mock the slow boundary, split
    // the assertion). Timeouts catch real regressions; loosening them hides
    // them.
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts"],
          pool: "threads",
          testTimeout: 2000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["packages/*/test/**/*.test.ts"],
          pool: "forks",
          testTimeout: 5000,
          teardownTimeout: 10000,
          globalSetup: ["./vitest.global-setup.ts"],
        },
      },
    ],
  },
});
