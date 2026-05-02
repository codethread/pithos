import * as esbuild from "esbuild"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(__dirname, "..")

await esbuild.build({
  entryPoints: [resolve(pkgRoot, "src/main.ts")],
  outfile: resolve(pkgRoot, "dist/main.js"),
  platform: "node",
  target: "node20",
  format: "esm",
  bundle: true,
  sourcemap: true,
  // Native addons must stay external — esbuild cannot bundle .node binaries.
  external: ["better-sqlite3"],
  // Transitive CJS deps (e.g. undici via @effect/platform-node) use dynamic
  // require() which ESM does not support natively. Inject createRequire so
  // the bundled require shim works at runtime.
  banner: {
    js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`,
  },
})
