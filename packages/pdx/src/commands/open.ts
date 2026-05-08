import { Effect } from "effect"
import type { Scope } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, open as openFile, readFile as readFileRaw, rm as rmFile } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { PdxError } from "../errors.ts"
import { DAEMON_TARGET, DEFAULT_HOME, logPath, resolveHome, runsDir, socketPath, statePath } from "../home.ts"
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

const waitForDaemonReadyTimeoutMs = Number(process.env.PDX_OPEN_READY_TIMEOUT_MS ?? "20000")
const staleDaemonConfirmationMs = 1_000

const openLockPath = (): string => process.env.PDX_OPEN_LOCK_PATH ?? join(DEFAULT_HOME, "pdx-open.lock")

const readOptionalFile = (
  fileSystem: {
    readonly readFileString: (path: string) => Effect.Effect<string, PdxError>
  },
  path: string,
): Effect.Effect<string | undefined, PdxError> =>
  fileSystem.readFileString(path).pipe(
    Effect.map((content) => content),
    Effect.catchTag("PdxError", (error) =>
      error.message.includes("ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  )

const summarizeMultiline = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }

  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  return lines.length === 0 ? undefined : lines.slice(-5).join(" | ")
}

const startupFailure = (
  home: string,
  message: string,
): Effect.Effect<PdxError, PdxError, FileSystem | Tmux> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const tmux = yield* Tmux

    const details: string[] = []
    const supervisorLog = summarizeMultiline(yield* readOptionalFile(fileSystem, logPath(home)))
    if (supervisorLog !== undefined) {
      details.push(`last supervisor log: ${supervisorLog}`)
    }

    const daemonState = summarizeMultiline(yield* readOptionalFile(fileSystem, statePath(home)))
    if (daemonState !== undefined) {
      details.push(`daemon state: ${daemonState}`)
    }

    if (yield* tmux.hasSession(DAEMON_TARGET)) {
      const paneOutput = summarizeMultiline(yield* tmux.capturePane(DAEMON_TARGET).pipe(
        Effect.catchTag("PdxError", () => Effect.succeed("")),
      ))
      if (paneOutput !== undefined) {
        details.push(`daemon pane: ${paneOutput}`)
      }
    }

    return new PdxError({
      code: "USER_ERROR",
      message: details.length === 0 ? message : `${message}; ${details.join("; ")}`,
    })
  })

const waitForDaemonReady = (home: string, startupToken: string): Effect.Effect<void, PdxError, FileSystem | Tmux> =>
  Effect.gen(function* () {
    const tmux = yield* Tmux
    const path = socketPath(home)
    const startedAt = Date.now()

    while (true) {
      const daemonSessionExists = yield* tmux.hasSession(DAEMON_TARGET)
      if (!daemonSessionExists) {
        return yield* Effect.fail(
          yield* startupFailure(home, `pdx daemon exited before readiness at ${path}`),
        )
      }

      const paneDead = yield* tmux.paneDead(DAEMON_TARGET)
      if (paneDead) {
        return yield* Effect.fail(
          yield* startupFailure(home, `pdx daemon exited before readiness at ${path}`),
        )
      }

      const response = yield* sendDaemonRequest(path, { type: "status" }).pipe(
        Effect.option,
      )
      if (
        response._tag === "Some" &&
        response.value.ok === true &&
        response.value.state?.daemon.startupToken === startupToken &&
        response.value.state.daemon.phase === "ready"
      ) {
        const pandora = response.value.state.registry.find((entry) => entry.agent === "pandora")
        if (
          pandora?.tmuxTarget === "pdx--pandora" &&
          pandora.state === "live"
        ) {
          return
        }
      }

      if (Date.now() - startedAt > waitForDaemonReadyTimeoutMs) {
        return yield* Effect.fail(
          yield* startupFailure(home, `Timed out waiting for daemon readiness at ${path}`),
        )
      }

      yield* Effect.sleep(100)
    }
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
    const cleanedRunIds = new Set<string>()

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
      cleanedRunIds.add(runId)
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

    const activeBuiltInRuns = yield* pithos.listActiveBuiltInRuns()
    for (const run of activeBuiltInRuns) {
      if (cleanedRunIds.has(run.id)) {
        continue
      }

      yield* pithos.cleanupRun({ runId: run.id, reason: orphanCleanupReason })
      cleanedRunIds.add(run.id)
    }
  })

const acquireOpenLock = (): Effect.Effect<FileHandle, PdxError> =>
  Effect.tryPromise({
    try: async () => {
      const path = openLockPath()
      const writeCurrentPid = async (): Promise<FileHandle> => {
        await mkdir(dirname(path), { recursive: true })
        const handle = await openFile(path, "wx")
        await handle.writeFile(`${process.pid}\n`, "utf8")
        return handle
      }

      try {
        return await writeCurrentPid()
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
          throw error
        }

        const existing = await readFileRaw(path, "utf8").catch(() => undefined)
        const pid = Number(existing?.trim())
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0)
            throw new PdxError({ code: "USER_ERROR", message: "pdx open already in progress" })
          } catch (probeError) {
            if (!(probeError && typeof probeError === "object" && "code" in probeError && probeError.code === "ESRCH")) {
              throw probeError
            }
          }
        }

        await rmFile(path, { force: true })
        return await writeCurrentPid()
      }
    },
    catch: (error) =>
      error instanceof PdxError
        ? error
        : new PdxError({ code: "USER_ERROR", message: `Failed to acquire pdx open lock: ${String(error)}` }),
  })

const releaseOpenLock = (handle: FileHandle): Effect.Effect<void, PdxError> =>
  Effect.tryPromise({
    try: async () => {
      await handle.close()
      await rmFile(openLockPath(), { force: true })
    },
    catch: (error) =>
      new PdxError({ code: "USER_ERROR", message: `Failed to release pdx open lock: ${String(error)}` }),
  })

const cleanupFailedStartup = (home: string, startupToken: string, error: PdxError): Effect.Effect<never, PdxError, FileSystem | PithosClient | ProcessService | Tmux> =>
  sendDaemonRequest(socketPath(home), { type: "status" }).pipe(
    Effect.option,
    Effect.flatMap((status) => {
      if (
        status._tag === "Some" &&
        status.value.ok === true &&
        status.value.state !== undefined &&
        status.value.state.daemon.startupToken !== startupToken
      ) {
        return Effect.fail(error)
      }

      return settleStartupOrphans(home).pipe(
        Effect.catchTag(
          "PdxError",
          (cleanupError) =>
            Effect.fail(
              new PdxError({
                code: "USER_ERROR",
                message: `${error.message}; additionally failed to settle startup debris: ${cleanupError.message}`,
              }),
            ),
        ),
        Effect.zipRight(Effect.fail(error)),
      )
    }),
  )

const ensureNoLiveDaemon = (home: string): Effect.Effect<void, PdxError, Tmux> =>
  Effect.gen(function* () {
    const tmux = yield* Tmux
    if (!(yield* tmux.hasSession(DAEMON_TARGET))) {
      return
    }

    const startedAt = Date.now()
    while (true) {
      const status = yield* sendDaemonRequest(socketPath(home), { type: "status" }).pipe(
        Effect.option,
      )
      if (status._tag === "Some" && status.value.ok === true && status.value.state !== undefined) {
        return yield* Effect.fail(
          new PdxError({ code: "USER_ERROR", message: `pdx daemon is already running at ${home}` }),
        )
      }

      const paneDead = yield* tmux.paneDead(DAEMON_TARGET)
      if (paneDead) {
        return
      }

      if (Date.now() - startedAt > staleDaemonConfirmationMs) {
        return yield* Effect.fail(
          new PdxError({
            code: "USER_ERROR",
            message: `tmux session ${DAEMON_TARGET} exists but daemon liveness could not be confirmed for ${home}`,
          }),
        )
      }

      yield* Effect.sleep(100)
    }
  })

export const openCommand = (options: {
  readonly home?: string
  readonly intervalSeconds?: number
  readonly maxAfk?: number
}): Effect.Effect<void, PdxError, FileSystem | OutputService | PithosClient | ProcessService | Tmux> => {
  const program: Effect.Effect<void, PdxError, FileSystem | OutputService | PithosClient | ProcessService | Tmux | Scope.Scope> = Effect.gen(function* () {
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

    yield* fileSystem.makeDirectory(home, { recursive: true })
    yield* Effect.acquireRelease(
      acquireOpenLock(),
      (handle) => releaseOpenLock(handle).pipe(Effect.catchTag("PdxError", () => Effect.void)),
    )
    yield* ensureNoLiveDaemon(home)
    yield* pithos.init()
    yield* settleStartupOrphans(home)

    const executable = process.argv[1]
    if (executable === undefined) {
      return yield* Effect.fail(new PdxError({ code: "INTERNAL_ERROR", message: "Missing pdx executable path" }))
    }

    const startupToken = randomUUID()
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
        PDX_STARTUP_TOKEN: startupToken,
      },
      remainOnExit: true,
    })

    yield* waitForDaemonReady(home, startupToken).pipe(
      Effect.catchTag("PdxError", (error) => cleanupFailedStartup(home, startupToken, error)),
    )
    yield* tmux.setRemainOnExit(DAEMON_TARGET, false)
    yield* output.print("tmux attach -t pdx--pandora")
  })

  return Effect.scoped(program)
}
