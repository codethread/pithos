import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { parseArgs } from "./cli/args.ts"
import { dispatch } from "./cli/dispatch.ts"
import { exitCodeFor } from "./errors/errors.ts"
import { DbServiceLive } from "./layers/db.ts"

const program = Effect.gen(function* () {
  const args = yield* parseArgs(process.argv.slice(2))
  yield* dispatch(args)
}).pipe(
  Effect.provide(DbServiceLive),
  Effect.catchTag("PithosError", (err) =>
    Effect.sync(() => {
      console.error(`pithos: ${err.message}`)
      process.exit(exitCodeFor(err.code))
    }),
  ),
)

NodeRuntime.runMain(program)
