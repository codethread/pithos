import { CliConfig, Command, HelpDoc, ValidationError } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { pdxCommand } from "./cli/commands.ts"
import { exitCodeFor } from "./errors.ts"
import { OutputService } from "./services/output.ts"
import { OutputServiceLive } from "./layers/output.ts"
import { ProcessServiceLive } from "./layers/process.ts"
import { TmuxLive } from "./layers/tmux.ts"
import { PithosClientLive } from "./layers/pithos.ts"
import { VERSION } from "./version.ts"

const cli = Command.run(pdxCommand, {
  name: "Pdx",
  version: VERSION,
  executable: "pdx",
})

const stripAnsi = (text: string): string =>
  text.replace(new RegExp(String.raw`\u001B\[[0-9;]*m`, "g"), "")

const emitStructuredError = (
  code: Parameters<typeof exitCodeFor>[0],
  message: string,
): Effect.Effect<never, never, OutputService> =>
  Effect.gen(function* () {
    const output = yield* OutputService
    yield* output.printError(JSON.stringify({ ok: false, error: { code, message } }))
    process.exit(exitCodeFor(code))
  })

const validationMessage = (error: ValidationError.ValidationError): string =>
  stripAnsi(HelpDoc.toAnsiText(error.error)).trimEnd()

const infrastructure = Layer.mergeAll(
  OutputServiceLive,
  ProcessServiceLive,
  NodeContext.layer,
  CliConfig.layer({ showBuiltIns: false }),
)

const appLayer = Layer.mergeAll(
  infrastructure,
  TmuxLive.pipe(Layer.provide(ProcessServiceLive)),
  PithosClientLive.pipe(Layer.provide(ProcessServiceLive)),
)

const program = cli(process.argv).pipe(
  Effect.catchTag("PdxError", (error) => emitStructuredError(error.code, error.message)),
  Effect.catchAll((error: unknown) =>
    ValidationError.isValidationError(error)
      ? emitStructuredError("VALIDATION_ERROR", validationMessage(error))
      : emitStructuredError(
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : "unexpected internal failure",
        ),
  ),
  Effect.provide(appLayer),
)

NodeRuntime.runMain(program)
