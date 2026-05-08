import { mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import crypto from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import { PdxError } from "./errors.ts"
import { DAEMON_TARGET, SYSTEM_RUN_ID, SYSTEM_SESSION_ID, logPath, runsDir, socketPath, statePath } from "./home.ts"
import type { DaemonRequest, DaemonResponse, DaemonState, RegistryEntry } from "./daemon-state.ts"
import { appendSupervisorLog } from "./supervisor-log.ts"
import { PithosClient } from "./services/pithos.ts"
import { ProcessService } from "./services/process.ts"
import { Tmux } from "./services/tmux.ts"

const GLOBAL_SCOPE_ID = "global"
const PANDORA_AGENT = "pandora"
const pdxPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoPackagesRoot = resolve(pdxPackageRoot, "..")
const pandoraSpawnBin = process.env.PANDORA_SPAWN_BIN ?? resolve(repoPackagesRoot, "spawner", "bin", "pandora-spawn")

const PreviewSchema = Schema.Struct({
  agent: Schema.Literal("pandora"),
  mode: Schema.Literal("hitl"),
  runId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  scopeId: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
  logicalName: Schema.NonEmptyString,
  harness: Schema.Struct({
    kind: Schema.String,
    argv: Schema.Array(Schema.String),
    env: Schema.Record({ key: Schema.String, value: Schema.String }),
  }),
})

interface RenderedPandora {
  readonly agent: "pandora"
  readonly mode: "hitl"
  readonly runId: string
  readonly sessionId: string
  readonly scopeId: string
  readonly cwd: string
  readonly logicalName: string
  readonly harness: {
    readonly kind: string
    readonly argv: readonly string[]
    readonly env: Readonly<Record<string, string>>
  }
}

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

const uniqueId = (prefix: "run" | "session"): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`

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

const decodePreview = (stdout: string): Effect.Effect<RenderedPandora, PdxError> =>
  Effect.try({
    try: () => JSON.parse(stdout) as unknown,
    catch: () => {
      throw new PdxError({ code: "USER_ERROR", message: `Invalid pandora-spawn preview JSON: ${stdout}` })
    },
  }).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknown(PreviewSchema)(raw).pipe(
        Effect.mapError(
          () => new PdxError({ code: "USER_ERROR", message: `Invalid pandora-spawn preview output: ${stdout}` }),
        ),
      ),
    ),
  )

export const probePidLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const aggregateClaimable = (
  nodes: readonly {
    readonly scope_id: string
    readonly capability: string
    readonly status: string
    readonly claimable: boolean
  }[],
): readonly { readonly scopeId: string; readonly capability: string; readonly count: number }[] => {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    if (!(node.status === "queued" && node.claimable)) {
      continue
    }
    const key = `${node.scope_id}::${node.capability}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([key, count]) => {
      const [scopeId, capability] = key.split("::")
      return { scopeId: scopeId!, capability: capability!, count }
    })
    .sort((a, b) =>
      a.scopeId.localeCompare(b.scopeId) || a.capability.localeCompare(b.capability),
    )
}

export const runDaemon = (input: {
  readonly home: string
  readonly maxAfk: number
  readonly intervalSeconds: number
}): Effect.Effect<void, PdxError, PithosClient | ProcessService | Tmux> =>
  Effect.gen(function* () {
    const pithos = yield* PithosClient
    const processService = yield* ProcessService
    const tmux = yield* Tmux
    const home = input.home
    const socket = socketPath(home)
    const stateFile = statePath(home)
    const logFile = logPath(home)
    let state = makeState(home, input.maxAfk, input.intervalSeconds)
    let shuttingDown = false
    let reconcileRunning = false
    let reconcileTimer: NodeJS.Timeout | null = null
    let server: net.Server | null = null

    const persistState = async (): Promise<void> => {
      await writeStateFile(stateFile, state)
    }

    const log = async (level: "info" | "warn" | "error", span: string, msg: string): Promise<void> => {
      const line = {
        ts: new Date().toISOString(),
        level,
        span,
        msg,
      }
      state = {
        ...state,
        recent: [...state.recent.slice(-19), line],
      }
      await appendSupervisorLog(logFile, line)
      await persistState()
    }

    const refreshQueue = async (): Promise<void> => {
      const nodes = await pithos.inspectGraphAll().pipe(Effect.runPromise)
      state = {
        ...state,
        queue: {
          claimable: aggregateClaimable(nodes),
        },
      }
      await persistState()
    }

    const setRegistry = async (registry: readonly RegistryEntry[]): Promise<void> => {
      state = {
        ...state,
        registry,
        caps: {
          ...state.caps,
          afkInUse: registry.filter((entry) => entry.mode === "afk").length,
        },
      }
      await persistState()
    }

    const waitForTmuxGone = async (target: string, timeoutMs: number): Promise<void> => {
      const startedAt = Date.now()
      while (await tmux.hasSession(target).pipe(Effect.runPromise)) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new PdxError({ code: "USER_ERROR", message: `Timed out waiting for ${target} to exit` })
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    const spawnPandora = async (): Promise<void> => {
      if (state.registry.some((entry) => entry.agent === PANDORA_AGENT && entry.state !== "terminating")) {
        return
      }

      const runId = uniqueId("run")
      const sessionId = uniqueId("session")
      await pithos.upsertRun({
        agent: "pandora",
        mode: "hitl",
        scopeId: GLOBAL_SCOPE_ID,
        cwd: home,
        runId,
        sessionId,
      }).pipe(Effect.runPromise)

      const launchingEntry: RegistryEntry = {
        runId,
        sessionId,
        agent: PANDORA_AGENT,
        scopeId: GLOBAL_SCOPE_ID,
        mode: "hitl",
        logicalName: "pdx--pandora",
        tmuxTarget: "pdx--pandora",
        state: "launching",
      }
      await setRegistry([...state.registry.filter((entry) => entry.agent !== PANDORA_AGENT), launchingEntry])

      try {
        const previewResult = await processService.exec(pandoraSpawnBin, [
          "preview",
          "--agent",
          "pandora",
          "--mode",
          "hitl",
          "--scope",
          GLOBAL_SCOPE_ID,
          "--run",
          runId,
          "--session-id",
          sessionId,
          "--cwd",
          home,
        ], {
          env: {
            ...(process.env.PITHOS_BIN === undefined ? {} : { PITHOS_BIN: process.env.PITHOS_BIN }),
            ...(process.env.PITHOS_DB === undefined ? {} : { PITHOS_DB: process.env.PITHOS_DB }),
            PANDORA_SPAWN_PACKAGE_ROOT: resolve(repoPackagesRoot, "spawner"),
          },
        }).pipe(Effect.runPromise)

        if (previewResult.exitCode !== 0) {
          throw new PdxError({
            code: "USER_ERROR",
            message: previewResult.stderr.trim() || `pandora-spawn preview failed with exit code ${previewResult.exitCode}`,
          })
        }

        const rendered = await decodePreview(previewResult.stdout).pipe(Effect.runPromise)
        await tmux.newSession({
          target: rendered.logicalName,
          cwd: rendered.cwd,
          argv: rendered.harness.argv,
          env: rendered.harness.env,
        }).pipe(Effect.runPromise)

        if (!(await tmux.hasSession(rendered.logicalName).pipe(Effect.runPromise))) {
          throw new PdxError({
            code: "USER_ERROR",
            message: `Pandora session ${rendered.logicalName} exited before launch completed`,
          })
        }

        const nextEntry: RegistryEntry = {
          runId,
          sessionId,
          agent: PANDORA_AGENT,
          scopeId: GLOBAL_SCOPE_ID,
          mode: "hitl",
          logicalName: rendered.logicalName,
          tmuxTarget: rendered.logicalName,
          state: "live",
        }
        await setRegistry([...state.registry.filter((entry) => entry.agent !== PANDORA_AGENT), nextEntry])
        await log("info", "pdx.reconcile.spawn", `spawned pandora run ${runId}`)
      } catch (error) {
        await setRegistry(state.registry.filter((entry) => entry.runId !== runId))
        try {
          await pithos.cleanupRun({ runId, reason: "spawn_failed" }).pipe(Effect.runPromise)
        } catch {
          // cleanup failure is logged via the original spawn error path below
        }
        throw error
      }
    }

    const cleanupRegistryEntry = async (entry: RegistryEntry, reason: string): Promise<void> => {
      await pithos.cleanupRun({ runId: entry.runId, reason }).pipe(Effect.runPromise)
      await setRegistry(state.registry.filter((candidate) => candidate.runId !== entry.runId))
      await log("info", "pdx.reconcile.cleanup", `cleaned up ${entry.agent} run ${entry.runId}`)
    }

    const reconcile = async (): Promise<void> => {
      if (shuttingDown || reconcileRunning) {
        return
      }

      reconcileRunning = true

      try {
        for (const entry of state.registry) {
          if (entry.mode === "hitl" && entry.tmuxTarget !== undefined) {
            const alive = await tmux.hasSession(entry.tmuxTarget).pipe(Effect.runPromise)
            if (!alive) {
              await cleanupRegistryEntry(entry, "natural_death")
            } else {
              await pithos.heartbeatRun({ runId: entry.runId }).pipe(Effect.runPromise)
            }
            continue
          }

          if (entry.mode === "afk" && entry.pid !== undefined && !probePidLive(entry.pid)) {
            await cleanupRegistryEntry(entry, "natural_death")
          }
        }

        await spawnPandora()
        await refreshQueue()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await log("error", "pdx.reconcile", message)
      } finally {
        reconcileRunning = false
        if (!shuttingDown) {
          reconcileTimer = setTimeout(() => {
            void reconcile()
          }, input.intervalSeconds * 1000)
        }
      }
    }

    const shutdown = async (): Promise<void> => {
      shuttingDown = true
      if (reconcileTimer !== null) {
        clearInterval(reconcileTimer)
        reconcileTimer = null
      }

      for (const entry of [...state.registry]) {
        if (entry.tmuxTarget !== undefined && (await tmux.hasSession(entry.tmuxTarget).pipe(Effect.runPromise))) {
          await tmux.killSession(entry.tmuxTarget).pipe(Effect.runPromise)
          await waitForTmuxGone(entry.tmuxTarget, 5_000)
        }

        await pithos.cleanupRun({ runId: entry.runId, reason: "pdx_close" }).pipe(Effect.runPromise)
        await setRegistry(state.registry.filter((candidate) => candidate.runId !== entry.runId))
      }

      await refreshQueue()
      await log("info", "pdx.shutdown", "daemon stopping")
    }

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(home, { recursive: true })
        await mkdir(runsDir(home), { recursive: true })
        await rm(socket, { force: true })
      },
      catch: (error) =>
        new PdxError({ code: "USER_ERROR", message: `Failed to prepare pdx home: ${String(error)}` }),
    })

    yield* pithos.upsertRun({
      agent: "pdx",
      mode: "afk",
      scopeId: GLOBAL_SCOPE_ID,
      cwd: home,
      runId: SYSTEM_RUN_ID,
      sessionId: SYSTEM_SESSION_ID,
    })

    yield* Effect.tryPromise({
      try: async () => {
        await log("info", "pdx.daemon", "daemon started")
        await spawnPandora()
        await refreshQueue()
      },
      catch: (error) => new PdxError({ code: "USER_ERROR", message: `Failed to initialize daemon state: ${String(error)}` }),
    }).pipe(
      Effect.catchTag("PdxError", (error) =>
        pithos.cleanupRun({ runId: SYSTEM_RUN_ID, reason: "daemon_start_failed" }).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.zipRight(Effect.fail(error)),
        ),
      ),
    )

    yield* Effect.async<void, PdxError>((resume) => {
      server = net.createServer((connection) => {
        let body = ""
        let handled = false
        connection.setEncoding("utf8")

        const respond = (response: DaemonResponse) => {
          connection.end(JSON.stringify(response))
        }

        const handleRequest = () => {
          if (handled || !body.includes("\n")) {
            return
          }
          handled = true

          let request: DaemonRequest
          try {
            request = parseRequest(body.trim())
          } catch (error) {
            const message = error instanceof PdxError ? error.message : "Invalid daemon request payload"
            void log("warn", "pdx.daemon", `invalid daemon request: ${message}`)
            respond({ ok: false, error: { message } })
            return
          }

          if (request.type === "status") {
            void refreshQueue().then(() => respond({ ok: true, state })).catch((error) => {
              respond({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } })
            })
            return
          }

          void shutdown().then(() => {
            respond({ ok: true })
            setTimeout(() => {
              server?.close(() => {
                void rm(socket, { force: true }).finally(() => resume(Effect.void))
              })
            }, 50)
          }).catch((error) => {
            respond({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } })
          })
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

      server.listen(socket, () => {
        void reconcile()
      })

      return Effect.sync(() => {
        if (reconcileTimer !== null) {
          clearInterval(reconcileTimer)
        }
        server?.close()
      })
    })
  })

