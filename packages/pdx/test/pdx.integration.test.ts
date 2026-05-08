import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const repoRoot = resolve(__dirname, "../../..")
const pdxBin = join(repoRoot, "packages/pdx/bin/pdx")
const pithosBin = join(repoRoot, "packages/pithos/bin/pithos-next")

const run = (args: readonly string[], home: string) =>
  spawnSync(pdxBin, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PITHOS_BIN: pithosBin,
      PITHOS_DB: join(home, "pithos-next.sqlite"),
    },
  })

interface StatusOutput {
  readonly daemon: { readonly running: boolean; readonly home: string }
  readonly registry: readonly unknown[]
  readonly queue: { readonly claimable: readonly unknown[] }
  readonly caps: { readonly maxAfk: number; readonly afkInUse: number }
}

interface LogLine {
  readonly ts: string
  readonly level: string
  readonly span: string
  readonly msg: string
}

const parseJson = <A>(text: string): A => JSON.parse(text) as A

describe("pdx skeleton", () => {
  const homes: string[] = []

  beforeAll(() => {
    const pithosBuild = spawnSync("pnpm", ["--filter", "@pithos/pithos", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
    if (pithosBuild.status !== 0) {
      throw new Error(pithosBuild.stderr || pithosBuild.stdout || "pithos build failed")
    }

    const pdxBuild = spawnSync("pnpm", ["--filter", "@pithos/pdx", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
    if (pdxBuild.status !== 0) {
      throw new Error(pdxBuild.stderr || pdxBuild.stdout || "pdx build failed")
    }
  })

  afterEach(() => {
    for (const home of homes.splice(0)) {
      spawnSync("tmux", ["kill-session", "-t", "pdx--daemon"], { encoding: "utf8" })
      spawnSync("rm", ["-rf", home])
    }
  })

  afterAll(() => {
    spawnSync("tmux", ["kill-session", "-t", "pdx--daemon"], { encoding: "utf8" })
  })

  it("open / status / logs / close round-trip works", async () => {
    const home = mkdtempSync(join(tmpdir(), "pdx-home-"))
    homes.push(home)

    const open = run(["open", "--home", home], home)
    expect(open.status).toBe(0)
    expect(open.stdout.trim()).toBe("tmux attach -t pdx--pandora")

    const statusUp = run(["status", "--home", home, "--json"], home)
    expect(statusUp.status).toBe(0)
    const parsedUp = parseJson<StatusOutput>(statusUp.stdout)
    expect(parsedUp).toMatchObject({
      daemon: { running: true, home },
      registry: [],
      queue: { claimable: [] },
      caps: { maxAfk: 4, afkInUse: 0 },
    })

    const logContent = await readFile(join(home, "pdx.jsonl"), "utf8")
    const firstLine = parseJson<LogLine>(logContent.trim().split("\n")[0] ?? "{}")
    expect(typeof firstLine.ts).toBe("string")
    expect(typeof firstLine.level).toBe("string")
    expect(typeof firstLine.span).toBe("string")
    expect(typeof firstLine.msg).toBe("string")

    const close = run(["close", "--home", home], home)
    expect(close.status).toBe(0)

    const statusDown = run(["status", "--home", home, "--json"], home)
    expect(statusDown.status).toBe(0)
    const parsedDown = parseJson<StatusOutput>(statusDown.stdout)
    expect(parsedDown).toMatchObject({
      daemon: { running: false, home },
      registry: [],
      queue: { claimable: [] },
      caps: { maxAfk: 0, afkInUse: 0 },
    })
  })
})
