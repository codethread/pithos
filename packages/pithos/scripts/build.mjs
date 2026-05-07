import * as esbuild from "esbuild"
import { chmod } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(__dirname, "..")
const args = new Set(process.argv.slice(2))
const dev = args.has("--dev")
const run = args.has("--run")
const outfile = resolve(pkgRoot, dev ? "bin/pithos-next-dev" : "bin/pithos-next")

await esbuild.build({
  entryPoints: [resolve(pkgRoot, "src/main.ts")],
  outfile,
  platform: "node",
  target: "es2024",
  format: "esm",
  bundle: true,
  sourcemap: dev ? "inline" : false,
  external: ["better-sqlite3"],
  banner: {
    js: `#!/usr/bin/env node\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);`,
  },
})

await chmod(outfile, 0o755)

if (run) {
  const passthroughIndex = process.argv.indexOf("--")
  const passthroughArgs = passthroughIndex === -1 ? [] : process.argv.slice(passthroughIndex + 1)
  const result = spawnSync(outfile, passthroughArgs, { stdio: "inherit" })
  process.exit(typeof result.status === "number" ? result.status : 1)
}
