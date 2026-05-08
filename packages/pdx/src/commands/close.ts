import { Effect } from "effect"
import { PdxError } from "../errors.ts"
import { DAEMON_TARGET, SYSTEM_RUN_ID, resolveHome, socketPath } from "../home.ts"
import { sendDaemonRequest } from "../socket-client.ts"
import { PithosClient } from "../services/pithos.ts"
import { Tmux } from "../services/tmux.ts"

const waitForTmuxDeath = (
  target: string,
  hasSession: (target: string) => Effect.Effect<boolean, PdxError>,
): Effect.Effect<void, PdxError> =>
  Effect.async<void, PdxError>((resume) => {
    const startedAt = Date.now()
    const interval = setInterval(() => {
      hasSession(target).pipe(Effect.runPromise).then((alive) => {
        if (!alive) {
          clearInterval(interval)
          resume(Effect.void)
          return
        }

        if (Date.now() - startedAt > 5000) {
          clearInterval(interval)
          resume(Effect.fail(new PdxError({ code: "USER_ERROR", message: `Timed out waiting for ${target} to exit` })))
        }
      }).catch((error: unknown) => {
        clearInterval(interval)
        resume(
          Effect.fail(
            error instanceof PdxError
              ? error
              : new PdxError({ code: "USER_ERROR", message: String(error) }),
          ),
        )
      })
    }, 100)

    return Effect.sync(() => clearInterval(interval))
  })

export const closeCommand = (options: {
  readonly home?: string
}): Effect.Effect<void, PdxError, PithosClient | Tmux> =>
  Effect.gen(function* () {
    const home = resolveHome(options.home)
    const tmux = yield* Tmux
    const pithos = yield* PithosClient

    if (!(yield* tmux.hasSession(DAEMON_TARGET))) {
      return yield* Effect.fail(new PdxError({ code: "USER_ERROR", message: "pdx daemon is not running" }))
    }

    yield* sendDaemonRequest(socketPath(home), { type: "shutdown" })
    yield* waitForTmuxDeath(DAEMON_TARGET, tmux.hasSession)
    yield* pithos.cleanupRun({ runId: SYSTEM_RUN_ID, reason: "pdx_close" })
  })
