import { Effect, Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { parseArgs } from "./cli/args.ts"
import { dispatch } from "./cli/dispatch.ts"
import { exitCodeFor } from "./errors/errors.ts"
import { DbServiceLive, makeDbServiceTest } from "./layers/db.ts"
import { IdServiceLive } from "./layers/ids.ts"
import { FsServiceLive } from "./layers/fs.ts"
import { OutputServiceLive } from "./layers/output.ts"
import { LoggerLive } from "./layers/logger.ts"
import { OutputService } from "./services/output.ts"

// ---------------------------------------------------------------------------
// Help / version fast path: skip DB acquisition so `pithos --help` never
// needs a valid database file.
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2)

/**
 * Returns true when the raw argv is a help or version invocation.
 * These commands never touch the DB, so we avoid opening SQLite entirely.
 */
const isHelpOrVersion = (argv: readonly string[]): boolean => {
  const first = argv[0]
  if (!first) return true // no args → show help
  if (first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help") return true
  // Subcommand help: --help or -h appears anywhere in the args
  return argv.includes("--help") || argv.includes("-h")
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const args = yield* parseArgs(rawArgs)
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
  Effect.provide(
    Layer.mergeAll(
      // For help/version commands, provide a no-op stub so dispatch type-checks
      // without opening SQLite. The stub is never called for those commands.
      isHelpOrVersion(rawArgs) ? makeDbServiceTest() : DbServiceLive,
      IdServiceLive,
      FsServiceLive,
      OutputServiceLive,
      LoggerLive,
    ),
  ),
)

NodeRuntime.runMain(program)
