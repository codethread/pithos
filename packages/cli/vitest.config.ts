import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		reporters: ["dot"],
		projects: ["./vitest.unit.config.ts", "./vitest.integration.config.ts"],
	},
});
