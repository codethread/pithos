import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["dot"],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onConsoleLog(_log: string, _type: "stdout" | "stderr") {
      return false;
    },
    name: "pithos-unit",
    include: ["src/**/*.test.ts"],
    pool: "threads",
    testTimeout: 2000,
  },
});
