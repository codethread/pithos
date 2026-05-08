import * as esbuild from "esbuild";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const dev = args.has("--dev");
const run = args.has("--run");
const outfile = resolve(pkgRoot, dev ? "bin/pandora-spawn-dev" : "bin/pandora-spawn");

await esbuild.build({
	entryPoints: [resolve(pkgRoot, "src/main.ts")],
	outfile,
	platform: "node",
	target: "es2024",
	format: "esm",
	bundle: true,
	sourcemap: dev ? "inline" : false,
	banner: {
		js: '#!/usr/bin/env node\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
	},
});

await chmod(outfile, 0o755);

if (run) {
	const passthroughIndex = process.argv.indexOf("--");
	const passthroughArgs = passthroughIndex === -1 ? [] : process.argv.slice(passthroughIndex + 1);
	const result = spawnSync(outfile, passthroughArgs, { stdio: "inherit" });
	process.exit(typeof result.status === "number" ? result.status : 1);
}
