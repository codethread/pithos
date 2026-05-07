import { Command, CliConfig, HelpDoc, ValidationError } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { pithosCommand } from "./cli/commands.ts"
import { type ErrorCode, exitCodeFor } from "./errors/errors.ts"
import { makeCliConsoleCapture } from "./layers/cli-console.ts"
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
  name: "Pithos Next",
  version: VERSION,
  executable: "pithos-next",
})

const cliConsole = makeCliConsoleCapture()
const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-9;]*m`, "g")

const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE_PATTERN, "")

const emitStructuredError = (
  code: ErrorCode,
  message: string,
): Effect.Effect<never, never, OutputService> =>
  Effect.gen(function* () {
    cliConsole.clear()
    const output = yield* OutputService
    yield* output.printError(JSON.stringify({ ok: false, error: { code, message } }))
    process.exit(exitCodeFor(code))
  })

const validationMessage = (error: ValidationError.ValidationError): string =>
  stripAnsi(HelpDoc.toAnsiText(error.error)).trimEnd()

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = cli(process.argv).pipe(
  Effect.tap(() => Effect.sync(() => cliConsole.flushToProcess())),
  Effect.catchTag("PithosError", (err) => emitStructuredError(err.code, err.message)),
  Effect.catchAll((error: unknown) =>
    ValidationError.isValidationError(error)
      ? emitStructuredError("VALIDATION_ERROR", validationMessage(error))
      : emitStructuredError(
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : "unexpected internal failure",
        ),
  ),
  Effect.provide(
    Layer.mergeAll(
      isNoDbNeeded(rawArgs) ? makeDbServiceTest() : DbServiceLive,
      IdServiceLive,
      FsServiceLive,
      OutputServiceLive,
      LoggerLive,
      cliConsole.layer,
      // Provides FileSystem, Path, Terminal required by @effect/cli internals.
      NodeContext.layer,
      CliConfig.layer({ showBuiltIns: false }),
    ),
  ),
)

NodeRuntime.runMain(program)
