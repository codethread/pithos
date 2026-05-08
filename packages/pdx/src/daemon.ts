import { mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { Effect } from "effect"
import { PdxError } from "./errors.ts"
import { DAEMON_TARGET, SYSTEM_RUN_ID, SYSTEM_SESSION_ID, logPath, runsDir, socketPath, statePath } from "./home.ts"
import type { DaemonRequest, DaemonResponse, DaemonState } from "./daemon-state.ts"
import { appendSupervisorLog } from "./supervisor-log.ts"
import { PithosClient } from "./services/pithos.ts"

const writeStateFile = (path: string, state: DaemonState): Promise<void> =>
  writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8")

const makeState = (home: string, maxAfk: number, intervalSeconds: number): DaemonState => ({
  daemon: {
    running: true,
    home,
    pid: process.pid,
    tmuxTarget: DAEMON_TARGET,
    startedAt: new Date().toISOString(),
    socketPath: socketPath(home),
    systemRunId: SYSTEM_RUN_ID,
    intervalSeconds,
  },
  registry: [],
  queue: {
    claimable: [],
  },
  caps: {
    maxAfk,
    afkInUse: 0,
  },
  recent: [],
})

const addRecent = (state: DaemonState, msg: string): DaemonState => {
  const entry = { ts: new Date().toISOString(), level: "info", span: "pdx.daemon", msg }
  return {
    ...state,
    recent: [...state.recent.slice(-19), entry],
  }
}

const logLine = async (path: string, msg: string): Promise<void> => {
  await appendSupervisorLog(path, {
    ts: new Date().toISOString(),
    level: "info",
    span: "pdx.daemon",
    msg,
  })
}

const parseRequest = (raw: string): DaemonRequest => {
  try {
    const parsed = JSON.parse(raw) as DaemonRequest
    if (parsed.type === "status" || parsed.type === "shutdown") {
      return parsed
    }
  } catch {
    // fall through
  }

  throw new PdxError({ code: "VALIDATION_ERROR", message: "Invalid daemon request payload" })
}

export const runDaemon = (input: {
  readonly home: string
  readonly maxAfk: number
  readonly intervalSeconds: number
}): Effect.Effect<void, PdxError, PithosClient> =>
  Effect.gen(function* () {
    const pithos = yield* PithosClient
    const home = input.home
    const socket = socketPath(home)
    const stateFile = statePath(home)
    const logFile = logPath(home)
    let state = makeState(home, input.maxAfk, input.intervalSeconds)

    yield* Effect.tryPromise({
      try: () => mkdir(home, { recursive: true }),
      catch: (error) =>
        new PdxError({ code: "USER_ERROR", message: `Failed to create pdx home ${home}: ${String(error)}` }),
    })
    yield* Effect.tryPromise({
      try: () => mkdir(runsDir(home), { recursive: true }),
      catch: (error) =>
        new PdxError({ code: "USER_ERROR", message: `Failed to create runs dir: ${String(error)}` }),
    })
    yield* Effect.tryPromise({
      try: () => rm(socket, { force: true }),
      catch: (error) =>
        new PdxError({ code: "USER_ERROR", message: `Failed to clear stale socket: ${String(error)}` }),
    })

    yield* pithos.upsertSystemRun({ home, runId: SYSTEM_RUN_ID, sessionId: SYSTEM_SESSION_ID })
    state = addRecent(state, "daemon started")
    yield* Effect.tryPromise({ try: () => logLine(logFile, "daemon started"), catch: (error) => new PdxError({ code: "USER_ERROR", message: `Failed to write supervisor log: ${String(error)}` }) })
    yield* Effect.tryPromise({ try: () => writeStateFile(stateFile, state), catch: (error) => new PdxError({ code: "USER_ERROR", message: `Failed to write daemon state file: ${String(error)}` }) })

    yield* Effect.async<void, PdxError>((resume) => {
      const server = net.createServer((connection) => {
        let body = ""
        let handled = false
        connection.setEncoding("utf8")

        const handleRequest = () => {
          if (handled || !body.includes("\n")) {
            return
          }
          handled = true

          let request: DaemonRequest
          try {
            request = parseRequest(body.trim())
          } catch (error) {
            const message =
              error instanceof PdxError ? error.message : "Invalid daemon request payload"
            void logLine(logFile, `invalid daemon request: ${message}`)
            connection.end(JSON.stringify({ ok: false, error: { message } }))
            return
          }

          const respond = (response: DaemonResponse) => {
            connection.end(JSON.stringify(response))
          }

          if (request.type === "status") {
            respond({ ok: true, state })
            return
          }

          if (request.type === "shutdown") {
            state = addRecent(state, "shutdown requested")
            void logLine(logFile, "shutdown requested")
            void writeStateFile(stateFile, state)

            void (async () => {
              try {
                connection.end(JSON.stringify({ ok: true }))
                setTimeout(() => {
                  server.close(() => {
                    void rm(socket, { force: true }).finally(() => {
                      resume(Effect.void)
                    })
                  })
                }, 50)
              } catch (error) {
                const message = error instanceof PdxError ? error.message : String(error)
                await logLine(logFile, `shutdown failed: ${message}`)
                connection.end(JSON.stringify({ ok: false, error: { message } }))
              }
            })()
          }
        }

        connection.on("data", (chunk: string | Buffer) => {
          body += typeof chunk === "string" ? chunk : chunk.toString("utf8")
          handleRequest()
        })
      })

      server.on("error", (error) => {
        resume(
          Effect.fail(
            new PdxError({ code: "USER_ERROR", message: `Daemon socket server failed: ${String(error)}` }),
          ),
        )
      })

      server.listen(socket)

      return Effect.sync(() => {
        server.close()
      })
    })
  })
