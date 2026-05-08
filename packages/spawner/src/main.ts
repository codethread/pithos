import { CliConfig, Command, HelpDoc } from "@effect/cli"
import * as ValidationError from "@effect/cli/ValidationError"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { DbServiceLive, makeDbServiceTest } from "@pithos/pithos/src/layers/db.ts"
import { Effect, Layer } from "effect"
import { makePandoraSpawnCommand } from "./cli.ts"
import { exitCodeFor } from "./errors.ts"
import { renderAgent } from "./harness.ts"
import { loadTemplate, TemplatePathsLive } from "./template.ts"
 import { validateManifestAgainstSeedRows } from "./capability-matrix.ts"
import { TmuxLive } from "./tmux.ts"

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const writeError = (code: string, message: string): void => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`)
}

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-9;]*m`, "g")

const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE_PATTERN, "")

const validationMessage = (error: ValidationError.ValidationError): string =>
  stripAnsi(HelpDoc.toAnsiText(error.error)).trimEnd()

const rawArgs = process.argv.slice(2)

const isNoDbNeeded = (argv: readonly string[]): boolean =>
  argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv.includes("--version")

const cli = Command.run(
  makePandoraSpawnCommand({
    preview: (input) =>
      loadTemplate(input.agent).pipe(
        Effect.flatMap(({ manifest }) => validateManifestAgainstSeedRows(manifest)),
        Effect.zipRight(renderAgent(input)),
        Effect.tap((rendered) => Effect.sync(() => writeJson(rendered))),
        Effect.asVoid,
      ),
  }),
  {
    name: "Pandora Spawn",
    version: "0.1.0",
    executable: "pandora-spawn",
  },
)

const program = cli(process.argv).pipe(
  Effect.provide(
    Layer.mergeAll(
      NodeContext.layer,
      CliConfig.layer({ showBuiltIns: true }),
      isNoDbNeeded(rawArgs) ? makeDbServiceTest() : DbServiceLive,
      TemplatePathsLive,
      TmuxLive,
    ),
  ),
  Effect.catchTag("SpawnerError", (error) =>
    Effect.sync(() => {
      writeError(error.code, error.message)
      process.exit(exitCodeFor(error.code))
    }),
  ),
  Effect.catchAll((error: unknown) =>
    ValidationError.isValidationError(error)
      ? Effect.sync(() => {
          writeError("VALIDATION_ERROR", validationMessage(error))
          process.exit(2)
        })
      : Effect.sync(() => {
          writeError("LAUNCH_ERROR", error instanceof Error ? error.message : String(error))
          process.exit(1)
        }),
  ),
)

NodeRuntime.runMain(program)
