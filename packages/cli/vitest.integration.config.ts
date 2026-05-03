import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["dot"],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onConsoleLog(_log: string, _type: "stdout" | "stderr") {
      return false;
    },
    dangerouslyIgnoreUnhandledErrors: true,
    name: "cli-integration",
    include: ["test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 5000,
    teardownTimeout: 10000,
    globalSetup: ["../../vitest.global-setup.ts"],
  },
});
