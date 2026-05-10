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
		projects: [
			"packages/pithos/vitest.config.ts",
			"packages/spawner/vitest.config.ts",
			"packages/pdx/vitest.config.ts",
		],
	},
});
