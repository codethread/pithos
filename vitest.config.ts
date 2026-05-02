import { defineConfig } from "vitest/config";

/**
 * Intercept unexpected console.log/warn/error calls in tests and fail loudly.
 * Commands must route all output through OutputService; raw console calls are a
 * contract violation. Tests that deliberately capture logs must use
 * makeLogCapture() or makeOutputServiceTest(), not console interception.
 *
 * Return false to suppress the output (prevent noise) AND throw so the test
 * fails with a clear message.
 */
function failOnConsoleLog(type: string, message: unknown): boolean {
  // Only block plain string messages from application code. vitest itself may
  // use console internally for structured objects (e.g. test runner internals).
  if (typeof message === "string") {
    throw new Error(
      `Unexpected console.${type} in test — route through OutputService or Effect logging instead.\nMessage: ${message}`,
    );
  }
  return true; // allow non-string (vitest-internal) console calls through
}

export default defineConfig({
  test: {
    reporters: ["dot"],
    onConsoleLog(message, type) {
      return failOnConsoleLog(type, message);
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
