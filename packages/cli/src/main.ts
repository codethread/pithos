import { Effect, Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { parseArgs } from "./cli/args.ts"
import { dispatch } from "./cli/dispatch.ts"
import { exitCodeFor } from "./errors/errors.ts"
import { DbServiceLive } from "./layers/db.ts"
import { IdServiceLive } from "./layers/ids.ts"
import { FsServiceLive } from "./layers/fs.ts"
import { OutputServiceLive } from "./layers/output.ts"

const program = Effect.gen(function* () {
  const args = yield* parseArgs(process.argv.slice(2))
  yield* dispatch(args)
}).pipe(
  Effect.provide(Layer.mergeAll(DbServiceLive, IdServiceLive, FsServiceLive, OutputServiceLive)),
  Effect.catchTag("PithosError", (err) =>
    Effect.sync(() => {
      process.stderr.write(
        JSON.stringify({ ok: false, error: { code: err.code, message: err.message } }) + "\n",
      )
      process.exit(exitCodeFor(err.code))
    }),
  ),
)

NodeRuntime.runMain(program)
