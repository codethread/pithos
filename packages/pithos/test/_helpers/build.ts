import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"

const execFileP = promisify(execFile)

export async function buildCli(pkgDir: string): Promise<void> {
  const script = join(pkgDir, "scripts", "build.mjs")
  await execFileP("node", [script], {
    cwd: pkgDir,
    env: process.env,
    encoding: "utf-8",
  })
}
