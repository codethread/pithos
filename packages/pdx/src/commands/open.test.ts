import { afterEach, describe, expect, it } from "vitest"
import net from "node:net"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { PdxError } from "../errors.ts"
import { runsDir, socketPath } from "../home.ts"
import { FileSystem } from "../services/filesystem.ts"
import { OutputService } from "../services/output.ts"
import { PithosClient, type GraphNodeSummary, type RunOutput } from "../services/pithos.ts"
import { ProcessService } from "../services/process.ts"
import { Tmux } from "../services/tmux.ts"
import { openCommand, settleStartupOrphans } from "./open.ts"

const homes: string[] = []

const toPdxError = (error: unknown): PdxError =>
  new PdxError({ code: "USER_ERROR", message: String(error) })

const realFileSystem = {
  makeDirectory: (path: string, options?: { readonly recursive?: boolean }) =>
    Effect.tryPromise({
      try: () => fs.mkdir(path, { recursive: options?.recursive === true }),
      catch: toPdxError,
    }).pipe(Effect.asVoid),
  readDirectory: (path: string) =>
    Effect.tryPromise({
      try: () => fs.readdir(path),
      catch: toPdxError,
    }),
  readFileString: (path: string) =>
    Effect.tryPromise({
      try: () => fs.readFile(path, "utf8"),
      catch: toPdxError,
    }),
  removeFile: (path: string) =>
    Effect.tryPromise({
      try: () => fs.rm(path, { force: true }),
      catch: toPdxError,
    }).pipe(Effect.asVoid),
}

const runOutput = (): RunOutput => ({
  id: "run_test",
  agent: "pdx",
  mode: "afk",
  scope_id: "global",
  status: "ended",
  task_id: null,
  session_id: "session_test",
  created_at: "2026-05-08T00:00:00.000Z",
  updated_at: "2026-05-08T00:00:00.000Z",
})

const makeHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "pdx-open-test-"))
  homes.push(home)
  return home
}

const withServices = <A>(
  effect: Effect.Effect<A, unknown, FileSystem | OutputService | PithosClient | ProcessService | Tmux>,
  services: {
    readonly fileSystem: typeof realFileSystem
    readonly output: {
      readonly print: (line: string) => Effect.Effect<void>
      readonly printError: (line: string) => Effect.Effect<void>
    }
    readonly pithos: {
      readonly init: () => Effect.Effect<void>
      readonly upsertRun: (input: {
        readonly agent: "pdx" | "pandora"
        readonly mode: "afk" | "hitl"
        readonly scopeId: string
        readonly cwd: string
        readonly runId: string
        readonly sessionId: string
      }) => Effect.Effect<RunOutput>
      readonly cleanupRun: (input: { readonly runId: string; readonly reason: string }) => Effect.Effect<RunOutput>
      readonly heartbeatRun: (input: { readonly runId: string }) => Effect.Effect<RunOutput>
      readonly inspectGraphAll: () => Effect.Effect<readonly GraphNodeSummary[]>
    }
    readonly process: {
      readonly exec: (command: string, args: readonly string[], options?: { readonly env?: Record<string, string>; readonly cwd?: string; readonly stdin?: string }) => Effect.Effect<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>
      readonly probePid: (pid: number) => Effect.Effect<boolean>
      readonly signalPid: (pid: number, signal: NodeJS.Signals) => Effect.Effect<void>
    }
    readonly tmux: {
      readonly hasSession: (target: string) => Effect.Effect<boolean>
      readonly lsSessions: () => Effect.Effect<readonly string[]>
      readonly newSession: (input: { readonly target: string; readonly cwd: string; readonly argv: readonly string[]; readonly env?: Readonly<Record<string, string>> }) => Effect.Effect<void>
      readonly killSession: (target: string) => Effect.Effect<void>
      readonly sendLiteralLine: (target: string, text: string) => Effect.Effect<void>
      readonly pasteBuffer: (target: string, content: string) => Effect.Effect<void>
    }
  },
) =>
  effect.pipe(
    Effect.provideService(Tmux, services.tmux),
    Effect.provideService(ProcessService, services.process),
    Effect.provideService(PithosClient, services.pithos),
    Effect.provideService(OutputService, services.output),
    Effect.provideService(FileSystem, services.fileSystem),
  )

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await fs.rm(home, { recursive: true, force: true })
  }
})

describe("settleStartupOrphans", () => {
  it("kills matching tmux sessions, reaps live and stale pidfiles, ignores non-pid entries, and is idempotent", async () => {
    const home = makeHome()
    mkdirSync(runsDir(home), { recursive: true })
    writeFileSync(join(runsDir(home), "run_live.pid"), "111\n")
    writeFileSync(join(runsDir(home), "run_stale.pid"), "222\n")
    writeFileSync(join(runsDir(home), "notes.txt"), "leave me alone\n")

    const killedSessions: string[] = []
    const cleanupCalls: { runId: string; reason: string }[] = []
    const signals: { pid: number; signal: NodeJS.Signals }[] = []
    const alive = new Map<number, boolean>([
      [111, true],
      [222, false],
    ])
    let tmuxPass = 0

    const services = {
      fileSystem: realFileSystem,
      output: {
        print: () => Effect.void,
        printError: () => Effect.void,
      },
      pithos: {
        init: () => Effect.void,
        upsertRun: () => Effect.succeed(runOutput()),
        cleanupRun: ({ runId, reason }: { readonly runId: string; readonly reason: string }) => {
          cleanupCalls.push({ runId, reason })
          return Effect.succeed(runOutput())
        },
        heartbeatRun: () => Effect.succeed(runOutput()),
        inspectGraphAll: () => Effect.succeed([]),
      },
      process: {
        exec: () => Effect.die("unused"),
        probePid: (pid: number) => Effect.succeed(alive.get(pid) ?? false),
        signalPid: (pid: number, signal: NodeJS.Signals) => {
          signals.push({ pid, signal })
          alive.set(pid, false)
          return Effect.void
        },
      },
      tmux: {
        hasSession: () => Effect.succeed(false),
        lsSessions: () => {
          tmuxPass += 1
          return Effect.succeed(tmuxPass === 1 ? ["pdx--orphan", "notes"] : ["notes"])
        },
        newSession: () => Effect.void,
        killSession: (target: string) => {
          killedSessions.push(target)
          return Effect.void
        },
        sendLiteralLine: () => Effect.void,
        pasteBuffer: () => Effect.void,
      },
    }

    await Effect.runPromise(withServices(settleStartupOrphans(home), services))

    expect(killedSessions).toEqual(["pdx--orphan"])
    expect(signals).toEqual([{ pid: 111, signal: "SIGTERM" }])
    expect(cleanupCalls).toEqual([
      { runId: "run_live", reason: "daemon_start" },
      { runId: "run_stale", reason: "daemon_start" },
    ])
    await expect(fs.access(join(runsDir(home), "run_live.pid"))).rejects.toThrow()
    await expect(fs.access(join(runsDir(home), "run_stale.pid"))).rejects.toThrow()
    await expect(fs.readFile(join(runsDir(home), "notes.txt"), "utf8")).resolves.toBe("leave me alone\n")

    cleanupCalls.length = 0
    killedSessions.length = 0
    signals.length = 0

    await Effect.runPromise(withServices(settleStartupOrphans(home), services))

    expect(killedSessions).toEqual([])
    expect(signals).toEqual([])
    expect(cleanupCalls).toEqual([])
  })
})

describe("openCommand", () => {
  it("settles startup orphans before init and daemon startup", async () => {
    const home = makeHome()
    mkdirSync(runsDir(home), { recursive: true })
    writeFileSync(join(runsDir(home), "run_orphan.pid"), "333\n")

    const events: string[] = []
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.end(
          JSON.stringify({
            ok: true,
            state: {
              daemon: { running: true, home, pid: 1, tmuxTarget: "pdx--daemon", startedAt: "2026-05-08T00:00:00.000Z", socketPath: socketPath(home), systemRunId: "run_pdx_system", intervalSeconds: 5 },
              registry: [
                {
                  runId: "run_pandora",
                  agent: "pandora",
                  scopeId: "global",
                  mode: "hitl",
                  logicalName: "pdx--pandora",
                  tmuxTarget: "pdx--pandora",
                  state: "live",
                },
              ],
              queue: { claimable: [] },
              caps: { maxAfk: 4, afkInUse: 0 },
              recent: [],
            },
          }),
        )
      })
    })

    await fs.mkdir(home, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath(home), () => {
        server.off("error", reject)
        resolve()
      })
    })

    let tmuxPass = 0

    const services = {
      fileSystem: {
        ...realFileSystem,
        makeDirectory: (path: string, options?: { readonly recursive?: boolean }) => {
          events.push(`mkdir:${path}`)
          return realFileSystem.makeDirectory(path, options)
        },
      },
      output: {
        print: (line: string) => {
          events.push(`print:${line}`)
          return Effect.void
        },
        printError: () => Effect.void,
      },
      pithos: {
        init: () => {
          events.push("pithos.init")
          return Effect.void
        },
        upsertRun: () => Effect.succeed(runOutput()),
        cleanupRun: ({ runId, reason }: { readonly runId: string; readonly reason: string }) => {
          events.push(`pithos.cleanup:${runId}:${reason}`)
          return Effect.succeed(runOutput())
        },
        heartbeatRun: () => Effect.succeed(runOutput()),
        inspectGraphAll: () => Effect.succeed([]),
      },
      process: {
        exec: () => Effect.die("unused"),
        probePid: () => Effect.succeed(false),
        signalPid: () => Effect.die("unused"),
      },
      tmux: {
        hasSession: () => Effect.succeed(false),
        lsSessions: () => {
          tmuxPass += 1
          return Effect.succeed(tmuxPass === 1 ? ["pdx--old", "keep-me"] : ["keep-me"])
        },
        newSession: ({ target }: { readonly target: string }) => {
          events.push(`tmux.new:${target}`)
          return Effect.void
        },
        killSession: (target: string) => {
          events.push(`tmux.kill:${target}`)
          return Effect.void
        },
        sendLiteralLine: () => Effect.void,
        pasteBuffer: () => Effect.void,
      },
    }

    try {
      await Effect.runPromise(withServices(openCommand({ home }), services))
    } finally {
      server.close()
    }

    expect(events).toContain("tmux.kill:pdx--old")
    expect(events).toContain("pithos.cleanup:run_orphan:daemon_start")
    expect(events).toContain("pithos.init")
    expect(events).toContain("tmux.new:pdx--daemon")
    expect(events.indexOf("pithos.init")).toBeLessThan(events.indexOf("tmux.kill:pdx--old"))
    expect(events.indexOf("pithos.init")).toBeLessThan(events.indexOf("pithos.cleanup:run_orphan:daemon_start"))
    expect(events.indexOf("tmux.kill:pdx--old")).toBeLessThan(events.indexOf("tmux.new:pdx--daemon"))
    expect(events.indexOf("pithos.cleanup:run_orphan:daemon_start")).toBeLessThan(events.indexOf("tmux.new:pdx--daemon"))
  })
})
