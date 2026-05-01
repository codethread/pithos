import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { parseArgs } from "./cli/args.ts"
import { dispatch } from "./cli/dispatch.ts"

const program = Effect.gen(function* () {
  const args = yield* parseArgs(process.argv.slice(2))
  yield* dispatch(args)
})

NodeRuntime.runMain(program)
