import { Effect, Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { parseArgs } from "./cli/args.ts"
import { dispatch } from "./cli/dispatch.ts"
import { exitCodeFor } from "./errors/errors.ts"
import { DbServiceLive } from "./layers/db.ts"
import { IdServiceLive } from "./layers/ids.ts"
import { FsServiceLive } from "./layers/fs.ts"
import { OutputServiceLive } from "./layers/output.ts"
import { OutputService } from "./services/output.ts"

const program = Effect.gen(function* () {
  const args = yield* parseArgs(process.argv.slice(2))
  yield* dispatch(args)
}).pipe(
  // catchTag runs inside the provided context so OutputService is available.
  Effect.catchTag("PithosError", (err) =>
    Effect.gen(function* () {
      const output = yield* OutputService
      yield* output.printError(
        JSON.stringify({ ok: false, error: { code: err.code, message: err.message } }),
      )
      process.exit(exitCodeFor(err.code))
    }),
  ),
  Effect.provide(Layer.mergeAll(DbServiceLive, IdServiceLive, FsServiceLive, OutputServiceLive)),
)

NodeRuntime.runMain(program)
