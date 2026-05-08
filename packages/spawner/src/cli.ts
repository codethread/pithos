import { Command, HelpDoc, Options } from "@effect/cli"
import type * as FileSystem from "@effect/platform/FileSystem"
import type { DbService } from "@pithos/pithos/src/services/db.ts"
import { Schema } from "effect"
import type { Effect } from "effect"
import type { SpawnerError } from "./errors.ts"
import type { RenderAgentInput } from "./harness.ts"
import type { TemplatePaths } from "./template.ts"

export const PreviewCliInputSchema = Schema.Struct({
  agent: Schema.Literal("pandora", "toil", "greed", "war"),
  mode: Schema.Literal("afk", "hitl"),
  runId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  scopeId: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
})

export type PreviewCliInput = Schema.Schema.Type<typeof PreviewCliInputSchema>

export interface CliHandlers {
  readonly preview: (
    input: RenderAgentInput,
  ) => Effect.Effect<void, SpawnerError, FileSystem.FileSystem | TemplatePaths | DbService>
}

const desc = (summary: string, examples: readonly string[]): HelpDoc.HelpDoc =>
  HelpDoc.blocks([
    HelpDoc.p(summary),
    HelpDoc.p("Examples:"),
    ...examples.map((example) => HelpDoc.p(`  ${example}`)),
    HelpDoc.p("Exit codes: 0 success | 2 validation/template error | 1 harness/launch error"),
  ])

export const makePandoraSpawnCommand = (handlers: CliHandlers) => {
  const preview = Command.make(
    "preview",
    {
      agent: Options.choice("agent", ["pandora", "toil", "greed", "war"] as const).pipe(
        Options.withDescription("Agent manifest to render"),
      ),
      mode: Options.choice("mode", ["afk", "hitl"] as const).pipe(
        Options.withDescription("Expected agent mode; must match the manifest"),
      ),
      scopeId: Options.text("scope").pipe(
        Options.withSchema(Schema.NonEmptyString),
        Options.withDescription("Scope id included in the rendered claim command"),
      ),
      runId: Options.text("run").pipe(
        Options.withSchema(Schema.NonEmptyString),
        Options.withDescription("Caller-supplied run id"),
      ),
      sessionId: Options.text("session-id").pipe(
        Options.withSchema(Schema.NonEmptyString),
        Options.withDescription("Caller-supplied session id"),
      ),
      cwd: Options.text("cwd").pipe(
        Options.withSchema(Schema.NonEmptyString),
        Options.withDescription("Working directory for the rendered harness session"),
      ),
    },
    ({ agent, mode, runId, sessionId, scopeId, cwd }) =>
      handlers.preview({
        agent,
        mode,
        runId,
        sessionId,
        scopeId,
        cwd,
      }),
  ).pipe(
    Command.withDescription(
      desc("Render one manifest as JSON without touching Pithos state.", [
        "pandora-spawn preview --agent pandora --mode hitl --scope global --run run_PREVIEW --session-id session_PREVIEW --cwd ~/.pandora",
        "pandora-spawn preview --agent war --mode afk --scope repo:work/example --run run_PREVIEW --session-id session_PREVIEW --cwd ~/work/example",
      ]),
    ),
  )

  return Command.make("pandora-spawn").pipe(
    Command.withDescription("Launcher-only spawner library with a preview CLI."),
    Command.withSubcommands([preview]),
  )
}
