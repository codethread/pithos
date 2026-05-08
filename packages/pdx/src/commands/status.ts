import { Effect } from "effect"
import { PdxError } from "../errors.ts"
import { resolveHome, socketPath } from "../home.ts"
import { sendDaemonRequest } from "../socket-client.ts"
import { OutputService } from "../services/output.ts"
import { Tmux } from "../services/tmux.ts"

export const statusCommand = (options: {
  readonly home?: string
  readonly json?: boolean
}): Effect.Effect<void, PdxError, OutputService | Tmux> =>
  Effect.gen(function* () {
    const home = resolveHome(options.home)
    const output = yield* OutputService
    const tmux = yield* Tmux

    if (!(yield* tmux.hasSession("pdx--daemon"))) {
      yield* output.print(
        JSON.stringify({
          daemon: { running: false, home },
          registry: [],
          queue: { claimable: [] },
          caps: { maxAfk: 0, afkInUse: 0 },
        }),
      )
      return
    }

    const response = yield* sendDaemonRequest(socketPath(home), { type: "status" })
    if (response.ok !== true || response.state === undefined) {
      return yield* Effect.fail(
        new PdxError({ code: "USER_ERROR", message: "daemon status response missing state" }),
      )
    }

    yield* output.print(JSON.stringify(response.state))
  })
