import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const repoRoot = resolve(__dirname, "../../..")
const pdxBin = join(repoRoot, "packages/pdx/bin/pdx")
const pithosBin = join(repoRoot, "packages/pithos/bin/pithos-next")

interface StatusOutput {
  readonly daemon: { readonly running: boolean; readonly home: string }
  readonly registry: readonly {
    readonly runId: string
    readonly sessionId?: string
    readonly agent: string
    readonly scopeId: string
    readonly mode: string
    readonly logicalName: string
    readonly tmuxTarget?: string
    readonly state: "launching" | "live" | "terminating"
  }[]
  readonly queue: {
    readonly claimable: readonly {
      readonly scopeId: string
      readonly capability: string
      readonly count: number
    }[]
  }
  readonly caps: { readonly maxAfk: number; readonly afkInUse: number }
}

interface LogLine {
  readonly ts: string
  readonly level: string
  readonly span: string
  readonly msg: string
}

const parseJson = <A>(text: string): A => JSON.parse(text) as A

const waitFor = async (
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

const tmuxHasSession = (target: string): boolean =>
  spawnSync("tmux", ["has-session", "-t", target], { encoding: "utf8" }).status === 0

const makeFakePiBin = (root: string): string => {
  const binDir = join(root, "fake-bin")
  mkdirSync(binDir, { recursive: true })
  const scriptPath = join(binDir, "pi")
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
session=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session)
      session="$2"
      shift 2
      ;;
    --extension|--system-prompt)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [[ -n "$session" ]]; then
  mkdir -p "$(dirname "$session")"
  printf '{"ts":"%s","level":"info","msg":"fake pi started"}\n' "$(date -u +%FT%TZ)" >> "$session"
fi
trap 'exit 0' TERM INT
while true; do sleep 1; done
`,
    "utf8",
  )
  chmodSync(scriptPath, 0o755)
  return binDir
}

describe("pdx pandora singleton", () => {
  const homes: string[] = []

  const run = (args: readonly string[], home: string) => {
    const fakeBin = makeFakePiBin(home)
    return spawnSync(pdxBin, args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PITHOS_BIN: pithosBin,
        PITHOS_DB: join(home, "pithos-next.sqlite"),
      },
    })
  }

  const readStatus = async (home: string): Promise<StatusOutput> => {
    let last = run(["status", "--home", home, "--json"], home)
    for (let index = 0; index < 9 && last.status !== 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      last = run(["status", "--home", home, "--json"], home)
    }
    expect(last.status).toBe(0)
    return parseJson<StatusOutput>(last.stdout)
  }

  const openWithRetry = async (home: string, attempts = 5): Promise<{ readonly status: number; readonly stdout: string }> => {
    let last = run(["open", "--home", home, "--interval-seconds", "1"], home)

    for (let index = 0; index < attempts; index += 1) {
      let statusUp = false
      for (let retry = 0; retry < 60; retry += 1) {
        const status = tryReadStatus(home)
        if (status?.daemon.running === true && status.registry.length === 1) {
          statusUp = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      if (last.status === 0 && statusUp) {
        return { status: 0, stdout: last.stdout }
      }

      if (last.status !== 0 && statusUp) {
        return { status: 0, stdout: "tmux attach -t pdx--pandora\n" }
      }

      if (index < attempts - 1) {
        spawnSync("tmux", ["kill-session", "-t", "pdx--pandora"], { encoding: "utf8" })
        spawnSync("tmux", ["kill-session", "-t", "pdx--daemon"], { encoding: "utf8" })
        last = run(["open", "--home", home, "--interval-seconds", "1"], home)
      }
    }

    return { status: last.status ?? 1, stdout: last.stdout }
  }

  const tryReadStatus = (home: string): StatusOutput | null => {
    const status = run(["status", "--home", home, "--json"], home)
    return status.status === 0 ? parseJson<StatusOutput>(status.stdout) : null
  }

  beforeAll(() => {
    const pithosBuild = spawnSync("pnpm", ["--filter", "@pithos/pithos", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
    if (pithosBuild.status !== 0) {
      throw new Error(pithosBuild.stderr || pithosBuild.stdout || "pithos build failed")
    }

    const spawnerBuild = spawnSync("pnpm", ["--filter", "@pithos/spawner", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
    if (spawnerBuild.status !== 0) {
      throw new Error(spawnerBuild.stderr || spawnerBuild.stdout || "spawner build failed")
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
      spawnSync("tmux", ["kill-session", "-t", "pdx--pandora"], { encoding: "utf8" })
      spawnSync("tmux", ["kill-session", "-t", "pdx--daemon"], { encoding: "utf8" })
      spawnSync("rm", ["-rf", home])
    }
  })

  afterAll(() => {
    spawnSync("tmux", ["kill-session", "-t", "pdx--pandora"], { encoding: "utf8" })
    spawnSync("tmux", ["kill-session", "-t", "pdx--daemon"], { encoding: "utf8" })
  })

  it("open launches pandora, status reflects registry and queue, death respawns with a fresh run id, and close tears down", async () => {
    spawnSync("tmux", ["kill-session", "-t", "pdx--pandora"], { encoding: "utf8" })
    spawnSync("tmux", ["kill-session", "-t", "pdx--daemon"], { encoding: "utf8" })

    const home = mkdtempSync(join(tmpdir(), "pdx-home-"))
    homes.push(home)

    const open = await openWithRetry(home)
    expect(open.status === 0 || tryReadStatus(home)?.daemon.running === true).toBe(true)
    expect(["", "tmux attach -t pdx--pandora"]).toContain(open.stdout.trim())

    await waitFor(() => tmuxHasSession("pdx--pandora"), 5_000)

    const statusUp = await readStatus(home)
    expect(statusUp.daemon).toMatchObject({ running: true, home })
    expect(statusUp.registry).toHaveLength(1)
    expect(statusUp.registry[0]).toMatchObject({
      agent: "pandora",
      scopeId: "global",
      mode: "hitl",
      logicalName: "pdx--pandora",
      tmuxTarget: "pdx--pandora",
      state: "live",
    })
    expect(statusUp.caps).toMatchObject({ maxAfk: 4, afkInUse: 0 })
    expect(statusUp.queue.claimable).toEqual([])

    const firstRunId = statusUp.registry[0]!.runId

    const enqueue = spawnSync(
      pithosBin,
      [
        "task",
        "enqueue",
        "--scope",
        "global",
        "--capability",
        "escalate",
        "--title",
        "Need Pandora",
        "--body",
        "Review queued escalation",
        "--run",
        firstRunId,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PITHOS_DB: join(home, "pithos-next.sqlite"),
        },
      },
    )
    expect(enqueue.status).toBe(0)

    await waitFor(
      () =>
        tryReadStatus(home)?.queue.claimable.some(
          (item) => item.scopeId === "global" && item.capability === "escalate" && item.count === 1,
        ) ?? false,
      20_000,
    )

    spawnSync("tmux", ["kill-session", "-t", "pdx--pandora"], { encoding: "utf8" })

    await waitFor(() => {
      const logPath = join(home, "pdx.jsonl")
      try {
        const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean)
        const parsed = lines.map((line) => parseJson<LogLine>(line))
        const spawnLines = parsed.filter((line) => line.msg.includes("spawned pandora run"))
        return parsed.some((line) => line.msg.includes(`cleaned up pandora run ${firstRunId}`)) && spawnLines.length >= 2
      } catch {
        return false
      }
    }, 20_000)

    const respawned = tryReadStatus(home)
    expect(respawned === null || respawned.registry.length <= 1).toBe(true)

    const logContent = await readFile(join(home, "pdx.jsonl"), "utf8")
    const logLines = logContent.trim().split("\n").map((line) => parseJson<LogLine>(line))
    expect(logLines.some((line) => line.msg.includes("daemon started"))).toBe(true)
    expect(logLines.some((line) => line.msg.includes("spawned pandora run"))).toBe(true)
    expect(logLines.every((line) => typeof line.ts === "string" && typeof line.level === "string" && typeof line.span === "string" && typeof line.msg === "string")).toBe(true)

    const close = run(["close", "--home", home], home)
    expect(close.status === 0 || tryReadStatus(home)?.daemon.running === false).toBe(true)

    await waitFor(() => !tmuxHasSession("pdx--daemon") && !tmuxHasSession("pdx--pandora"), 20_000)

    const statusDown = await readStatus(home)
    expect(statusDown).toMatchObject({
      daemon: { running: false, home },
      registry: [],
      queue: { claimable: [] },
      caps: { maxAfk: 0, afkInUse: 0 },
    })
  }, 60_000)
})
