import { Effect } from "effect"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { PdxError } from "../errors.ts"
import { DAEMON_TARGET, resolveHome, runsDir, socketPath } from "../home.ts"
import { sendDaemonRequest } from "../socket-client.ts"
import { FileSystem } from "../services/filesystem.ts"
import { OutputService } from "../services/output.ts"
import { PithosClient } from "../services/pithos.ts"
import { ProcessService } from "../services/process.ts"
import { Tmux } from "../services/tmux.ts"

const orphanSessionPrefix = "pdx--"
const orphanCleanupReason = "daemon_start"
const shutdownWaitMs = 100
const shutdownProbeAttempts = 5

const resolvePathForDaemon = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (isAbsolute(value)) {
    return value
  }

  return value.includes("/") || value.includes("\\") ? resolve(process.cwd(), value) : value
}

const resolvePithosBinForDaemon = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) {
    return resolve(process.cwd(), value)
  }

  return value
}

const waitForDaemonReady = (path: string): Effect.Effect<void, PdxError> =>
  Effect.async<void, PdxError>((resume) => {
    const startedAt = Date.now()
    const interval = setInterval(() => {
      sendDaemonRequest(path, { type: "status" }).pipe(Effect.runPromise).then((response) => {
        if (response.ok !== true || response.state === undefined) {
          return
        }

        const pandora = response.state.registry.find((entry) => entry.agent === "pandora")
        if (pandora?.state === "live" && pandora.tmuxTarget === "pdx--pandora") {
          clearInterval(interval)
          resume(Effect.void)
        }
      }).catch(() => {
        // keep polling until timeout
      }).finally(() => {
        if (Date.now() - startedAt > 5000) {
          clearInterval(interval)
          resume(
            Effect.fail(
              new PdxError({ code: "USER_ERROR", message: `Timed out waiting for daemon readiness at ${path}` }),
            ),
          )
        }
      })
    }, 100)

    return Effect.sync(() => clearInterval(interval))
  })

const parseRunIdFromPidfile = (entry: string): Effect.Effect<string, PdxError> => {
  if (!entry.endsWith(".pid")) {
    return Effect.fail(
      new PdxError({ code: "VALIDATION_ERROR", message: `Invalid pidfile name: ${entry}` }),
    )
  }

  const runId = entry.slice(0, -4)
  if (runId.length === 0) {
    return Effect.fail(
      new PdxError({ code: "VALIDATION_ERROR", message: `Invalid pidfile name: ${entry}` }),
    )
  }

  return Effect.succeed(runId)
}

const parsePid = (raw: string, path: string): Effect.Effect<number, PdxError> => {
  const trimmed = raw.trim()
  const pid = Number(trimmed)

  if (!Number.isInteger(pid) || pid <= 0) {
    return Effect.fail(
      new PdxError({
        code: "VALIDATION_ERROR",
        message: `Invalid pidfile contents at ${path}: expected positive integer pid, got '${trimmed}'`,
      }),
    )
  }

  return Effect.succeed(pid)
}

const readPidEntries = (
  fileSystem: {
    readonly readDirectory: (path: string) => Effect.Effect<readonly string[], PdxError>
  },
  home: string,
): Effect.Effect<readonly string[], PdxError> =>
  fileSystem.readDirectory(runsDir(home)).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.endsWith(".pid"))),
    Effect.catchTag("PdxError", (error) =>
      error.message.includes("ENOENT") ? Effect.succeed([]) : Effect.fail(error),
    ),
  )

const waitForProcessExit = (
  processService: {
    readonly probePid: (pid: number) => Effect.Effect<boolean, PdxError>
  },
  pid: number,
  attemptsRemaining: number,
): Effect.Effect<boolean, PdxError> =>
  processService.probePid(pid).pipe(
    Effect.flatMap((alive) => {
      if (!alive) {
        return Effect.succeed(true)
      }

      if (attemptsRemaining <= 0) {
        return Effect.succeed(false)
      }

      return Effect.sleep(shutdownWaitMs).pipe(
        Effect.flatMap(() => waitForProcessExit(processService, pid, attemptsRemaining - 1)),
      )
    }),
  )

const killOrphanProcess = (
  processService: {
    readonly probePid: (pid: number) => Effect.Effect<boolean, PdxError>
    readonly signalPid: (pid: number, signal: NodeJS.Signals) => Effect.Effect<void, PdxError>
  },
  pid: number,
): Effect.Effect<void, PdxError> =>
  Effect.gen(function* () {
    yield* processService.signalPid(pid, "SIGTERM")

    const exitedAfterTerm = yield* waitForProcessExit(processService, pid, shutdownProbeAttempts)
    if (exitedAfterTerm) {
      return
    }

    yield* processService.signalPid(pid, "SIGKILL")

    const exitedAfterKill = yield* waitForProcessExit(processService, pid, shutdownProbeAttempts)
    if (!exitedAfterKill) {
      return yield* Effect.fail(
        new PdxError({ code: "USER_ERROR", message: `Process ${pid} did not exit after SIGKILL` }),
      )
    }
  })

export const settleStartupOrphans = (home: string): Effect.Effect<void, PdxError, FileSystem | PithosClient | ProcessService | Tmux> =>
  Effect.gen(function* () {
    const tmux = yield* Tmux
    const pithos = yield* PithosClient
    const fileSystem = yield* FileSystem
    const processService = yield* ProcessService

    const orphanSessions = (yield* tmux.lsSessions()).filter((name) => name.startsWith(orphanSessionPrefix))
    for (const session of orphanSessions) {
      yield* tmux.killSession(session)
    }

    const pidEntries = yield* readPidEntries(fileSystem, home)
    for (const entry of pidEntries) {
      const pidfilePath = join(runsDir(home), entry)
      const runId = yield* parseRunIdFromPidfile(entry)
      const pid = yield* fileSystem.readFileString(pidfilePath).pipe(Effect.flatMap((raw) => parsePid(raw, pidfilePath)))
      const alive = yield* processService.probePid(pid)

      if (alive) {
        yield* killOrphanProcess(processService, pid)
      }

      yield* pithos.cleanupRun({ runId, reason: orphanCleanupReason })
      yield* fileSystem.removeFile(pidfilePath)
    }

    const remainingSessions = (yield* tmux.lsSessions()).filter((name) => name.startsWith(orphanSessionPrefix))
    if (remainingSessions.length > 0) {
      return yield* Effect.fail(
        new PdxError({
          code: "USER_ERROR",
          message: `Startup orphan cleanup left tmux sessions behind: ${remainingSessions.join(", ")}`,
        }),
      )
    }

    const remainingPidfiles = yield* readPidEntries(fileSystem, home)
    if (remainingPidfiles.length > 0) {
      return yield* Effect.fail(
        new PdxError({
          code: "USER_ERROR",
          message: `Startup orphan cleanup left pidfiles behind: ${remainingPidfiles.join(", ")}`,
        }),
      )
    }
  })

export const openCommand = (options: {
  readonly home?: string
  readonly intervalSeconds?: number
  readonly maxAfk?: number
}): Effect.Effect<void, PdxError, FileSystem | OutputService | PithosClient | ProcessService | Tmux> =>
  Effect.gen(function* () {
    const home = resolveHome(options.home)
    const tmux = yield* Tmux
    const pithos = yield* PithosClient
    const output = yield* OutputService
    const fileSystem = yield* FileSystem

    const intervalSeconds = options.intervalSeconds ?? 5
    const maxAfk = options.maxAfk ?? 4

    if (intervalSeconds <= 0) {
      return yield* Effect.fail(
        new PdxError({ code: "VALIDATION_ERROR", message: "--interval-seconds must be greater than 0" }),
      )
    }

    if (maxAfk < 0) {
      return yield* Effect.fail(
        new PdxError({ code: "VALIDATION_ERROR", message: "--max-afk must be greater than or equal to 0" }),
      )
    }

    if (yield* tmux.hasSession(DAEMON_TARGET)) {
      return yield* Effect.fail(
        new PdxError({ code: "USER_ERROR", message: `tmux session ${DAEMON_TARGET} already exists` }),
      )
    }

    yield* fileSystem.makeDirectory(home, { recursive: true })
    yield* pithos.init()
    yield* settleStartupOrphans(home)

    const executable = process.argv[1]
    if (executable === undefined) {
      return yield* Effect.fail(new PdxError({ code: "INTERNAL_ERROR", message: "Missing pdx executable path" }))
    }

    const resolvedExecutable = resolve(process.cwd(), executable)
    const resolvedPithosBin = resolvePithosBinForDaemon(process.env.PITHOS_BIN)
    const resolvedPithosDb = resolvePathForDaemon(process.env.PITHOS_DB)
    const spawnerPackageRoot = resolve(dirname(resolvedExecutable), "..", "..", "spawner")

    yield* tmux.newSession({
      target: DAEMON_TARGET,
      cwd: home,
      argv: [
        resolvedExecutable,
        "daemon",
        "run",
        "--home",
        home,
        "--interval-seconds",
        String(intervalSeconds),
        "--max-afk",
        String(maxAfk),
      ],
      env: {
        ...(resolvedPithosBin === undefined ? {} : { PITHOS_BIN: resolvedPithosBin }),
        ...(resolvedPithosDb === undefined ? {} : { PITHOS_DB: resolvedPithosDb }),
        PANDORA_SPAWN_PACKAGE_ROOT: spawnerPackageRoot,
      },
    })

    yield* waitForDaemonReady(socketPath(home))
    yield* output.print("tmux attach -t pdx--pandora")
  })
