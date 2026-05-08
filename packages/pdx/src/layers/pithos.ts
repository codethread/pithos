import { Effect, Layer, Schema } from "effect"
import { PdxError } from "../errors.ts"
import { ProcessService } from "../services/process.ts"
import { PithosClient, type RunOutput } from "../services/pithos.ts"

const RunOutputSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  agent: Schema.NonEmptyString,
  mode: Schema.NonEmptyString,
  scope_id: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  task_id: Schema.NullOr(Schema.NonEmptyString),
  session_id: Schema.NonEmptyString,
  created_at: Schema.NonEmptyString,
  updated_at: Schema.NonEmptyString,
})

const JsonEnvelopeSchema = <A, I>(inner: Schema.Schema<A, I>) =>
  Schema.Struct({
    ok: Schema.Literal(true),
    run: inner,
  })

const pithosBin = (): string => process.env.PITHOS_BIN ?? "pithos-next"

const decodeRunEnvelope = (stdout: string): Effect.Effect<RunOutput, PdxError> =>
  Effect.try({
    try: () => JSON.parse(stdout) as unknown,
    catch: () => {
      throw new PdxError({ code: "USER_ERROR", message: `Invalid Pithos JSON: ${stdout}` })
    },
  }).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknown(JsonEnvelopeSchema(RunOutputSchema))(raw).pipe(
        Effect.map((decoded) => decoded.run),
        Effect.mapError(
          () => new PdxError({ code: "USER_ERROR", message: `Invalid Pithos run output: ${stdout}` }),
        ),
      ),
    ),
  )

export const PithosClientLive: Layer.Layer<PithosClient, never, ProcessService> = Layer.effect(
  PithosClient,
  Effect.gen(function* () {
    const process = yield* ProcessService

    const runJsonCommand = (args: readonly string[]): Effect.Effect<RunOutput, PdxError> =>
      Effect.gen(function* () {
        const result = yield* process.exec(pithosBin(), args)

        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new PdxError({
              code: "USER_ERROR",
              message: result.stderr.trim() || `Pithos command failed: ${pithosBin()} ${args.join(" ")}`,
            }),
          )
        }

        return yield* decodeRunEnvelope(result.stdout)
      })

    return {
      init: () =>
        Effect.gen(function* () {
          const result = yield* process.exec(pithosBin(), ["init"])
          if (result.exitCode !== 0) {
            return yield* Effect.fail(
              new PdxError({ code: "USER_ERROR", message: result.stderr.trim() || "pithos init failed" }),
            )
          }
        }),
      upsertSystemRun: ({ home, runId, sessionId }) =>
        runJsonCommand([
          "run",
          "upsert",
          "--agent",
          "pdx",
          "--mode",
          "afk",
          "--scope",
          "global",
          "--cwd",
          home,
          "--session-id",
          sessionId,
          "--run",
          runId,
        ]),
      cleanupRun: ({ runId, reason }) =>
        runJsonCommand(["run", "cleanup", "--run", runId, "--reason", reason]),
    }
  }),
)
