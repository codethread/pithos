import { Effect, Layer, Schema } from "effect"
import { PdxError } from "../errors.ts"
import { ProcessService } from "../services/process.ts"
import { PithosClient, type GraphNodeSummary, type RunOutput } from "../services/pithos.ts"

const RunOutputSchema = Schema.Union(
  Schema.Struct({
    id: Schema.NonEmptyString,
    agent: Schema.NonEmptyString,
    mode: Schema.NonEmptyString,
    scope_id: Schema.NonEmptyString,
    status: Schema.NonEmptyString,
    task_id: Schema.NullOr(Schema.NonEmptyString),
    session_id: Schema.NonEmptyString,
    created_at: Schema.NonEmptyString,
    updated_at: Schema.NonEmptyString,
  }),
  Schema.Struct({
    id: Schema.NonEmptyString,
    agent_kind: Schema.NonEmptyString,
    mode: Schema.NonEmptyString,
    scope_id: Schema.NonEmptyString,
    status: Schema.NonEmptyString,
    task_id: Schema.NullOr(Schema.NonEmptyString),
    session_id: Schema.NonEmptyString,
    created_at: Schema.NonEmptyString,
    updated_at: Schema.NonEmptyString,
  }).pipe(
    Schema.transform(
      Schema.Struct({
        id: Schema.NonEmptyString,
        agent: Schema.NonEmptyString,
        mode: Schema.NonEmptyString,
        scope_id: Schema.NonEmptyString,
        status: Schema.NonEmptyString,
        task_id: Schema.NullOr(Schema.NonEmptyString),
        session_id: Schema.NonEmptyString,
        created_at: Schema.NonEmptyString,
        updated_at: Schema.NonEmptyString,
      }),
      {
        strict: true,
        decode: (input) => ({ ...input, agent: input.agent_kind }),
        encode: (input) => ({ ...input, agent_kind: input.agent }),
      },
    ),
  ),
)

const GraphNodeSummarySchema = Schema.Struct({
  id: Schema.NonEmptyString,
  scope_id: Schema.NonEmptyString,
  capability: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  claimable: Schema.Boolean,
})

const JsonEnvelopeSchema = <A, I>(inner: Schema.Schema<A, I>) =>
  Schema.Struct({
    ok: Schema.Literal(true),
    run: inner,
  })

const GraphEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  graph: Schema.Struct({
    nodes: Schema.Array(GraphNodeSummarySchema),
  }),
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

const decodeGraphEnvelope = (stdout: string): Effect.Effect<readonly GraphNodeSummary[], PdxError> =>
  Effect.try({
    try: () => JSON.parse(stdout) as unknown,
    catch: () => {
      throw new PdxError({ code: "USER_ERROR", message: `Invalid Pithos JSON: ${stdout}` })
    },
  }).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknown(GraphEnvelopeSchema)(raw).pipe(
        Effect.map((decoded) => decoded.graph.nodes),
        Effect.mapError(
          () => new PdxError({ code: "USER_ERROR", message: `Invalid Pithos graph output: ${stdout}` }),
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

    const graphJsonCommand = (args: readonly string[]): Effect.Effect<readonly GraphNodeSummary[], PdxError> =>
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

        return yield* decodeGraphEnvelope(result.stdout)
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
      upsertRun: ({ agent, mode, scopeId, cwd, runId, sessionId }) =>
        runJsonCommand([
          "run",
          "upsert",
          "--agent",
          agent,
          "--mode",
          mode,
          "--scope",
          scopeId,
          "--cwd",
          cwd,
          "--session-id",
          sessionId,
          "--run",
          runId,
        ]),
      cleanupRun: ({ runId, reason }) =>
        runJsonCommand(["run", "cleanup", "--run", runId, "--reason", reason]),
      heartbeatRun: ({ runId }) => runJsonCommand(["task", "heartbeat", "--run", runId]),
      inspectGraphAll: () => graphJsonCommand(["graph", "inspect", "--all"]),
    }
  }),
)
