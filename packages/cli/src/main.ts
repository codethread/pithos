import { Command, CliConfig } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { pithosCommand } from "./cli/commands.ts"
import { exitCodeFor } from "./errors/errors.ts"
import { DbServiceLive, makeDbServiceTest } from "./layers/db.ts"
import { IdServiceLive } from "./layers/ids.ts"
import { FsServiceLive } from "./layers/fs.ts"
import { OutputServiceLive } from "./layers/output.ts"
import { LoggerLive } from "./layers/logger.ts"
import { OutputService } from "./services/output.ts"
import { VERSION } from "./version.ts"

// ---------------------------------------------------------------------------
// Help / version fast path
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2)

/**
 * Returns true when the invocation will never reach a command handler that
 * needs the DB. @effect/cli handles --help, --version, and no-args internally
 * without calling command handlers, so we skip the heavyweight SqliteClient
 * acquisition and provide a no-op stub instead.
 */
const isNoDbNeeded = (argv: readonly string[]): boolean =>
  argv.length === 0 ||
  argv.includes("--help") ||
  argv.includes("-h") ||
  argv.includes("--version")

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

const cli = Command.run(pithosCommand, {
  name: "Pithos",
  version: VERSION,
  executable: "pithos",
})

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = cli(process.argv).pipe(
  // Catch PithosError: emit structured JSON to stderr and use our exit codes.
  Effect.catchTag("PithosError", (err) =>
    Effect.gen(function* () {
      const output = yield* OutputService
      yield* output.printError(
        JSON.stringify({ ok: false, error: { code: err.code, message: err.message } }),
      )
      process.exit(exitCodeFor(err.code))
    }),
  ),
  // Catch @effect/cli ValidationError: the library has already printed the
  // error to stderr; map to exit code 2 to preserve the CLI error contract.
  Effect.catchAll(() => Effect.sync(() => process.exit(2))),
  Effect.provide(
    Layer.mergeAll(
      isNoDbNeeded(rawArgs) ? makeDbServiceTest() : DbServiceLive,
      IdServiceLive,
      FsServiceLive,
      OutputServiceLive,
      LoggerLive,
      // Provides FileSystem, Path, Terminal required by @effect/cli internals.
      NodeContext.layer,
      CliConfig.layer({ showBuiltIns: false }),
    ),
  ),
)

NodeRuntime.runMain(program)
