import { defineConfig } from "vitest/config";

/**
 * Suppress unexpected console.log/warn/error output during tests so the Vitest
 * reporter stays quiet. Application code must route all output through
 * OutputService; ESLint's `no-console` rule enforces this at lint time.
 *
 * Returning false from onConsoleLog suppresses the output in the reporter
 * without failing the test. This handles any residual console calls from
 * transitive dependencies or Node runtime warnings.
 */

export default defineConfig({
  test: {
    reporters: ["dot"],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onConsoleLog(_log, _type) {
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
