import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { PdxError } from "../errors.ts"
import { DAEMON_TARGET, resolveHome, socketPath } from "../home.ts"
import { sendDaemonRequest } from "../socket-client.ts"
import { OutputService } from "../services/output.ts"
import { PithosClient } from "../services/pithos.ts"
import { Tmux } from "../services/tmux.ts"

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

export const openCommand = (options: {
  readonly home?: string
  readonly intervalSeconds?: number
  readonly maxAfk?: number
}): Effect.Effect<void, PdxError, OutputService | PithosClient | Tmux> =>
  Effect.gen(function* () {
    const home = resolveHome(options.home)
    const tmux = yield* Tmux
    const pithos = yield* PithosClient
    const output = yield* OutputService

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

    yield* Effect.tryPromise({
      try: () => mkdir(home, { recursive: true }),
      catch: (error) =>
        new PdxError({ code: "USER_ERROR", message: `Failed to create pdx home ${home}: ${String(error)}` }),
    })

    yield* pithos.init()

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
