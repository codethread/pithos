import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    reporters: ["dot"],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onConsoleLog(_log: string, _type: "stdout" | "stderr") {
      return false
    },
    name: "pdx",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 20000,
    teardownTimeout: 10000,
    globalSetup: ["../../vitest.global-setup.ts"],
  },
})
