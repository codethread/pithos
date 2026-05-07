import { Effect, Schema } from "effect"
import type { RunRow } from "../db/rows.ts"
import { PithosError } from "../errors/errors.ts"

const NonEmptyString = Schema.NonEmptyString

const decodeRunIdValue = (
  raw: string,
  source: "--run" | "PITHOS_RUN_ID",
): Effect.Effect<string, PithosError> =>
  Schema.decodeUnknown(NonEmptyString)(raw).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `${source} must be a non-empty string`,
        }),
    ),
  )

export const resolveMutatingTaskRunId = (
  explicitRun: string | undefined,
  envRunId = process.env.PITHOS_RUN_ID,
): Effect.Effect<string | undefined, PithosError> =>
  Effect.gen(function* () {
    const decodedExplicit =
      explicitRun === undefined ? undefined : yield* decodeRunIdValue(explicitRun, "--run")
    const decodedEnv = envRunId === undefined ? undefined : yield* decodeRunIdValue(envRunId, "PITHOS_RUN_ID")

    if (
      decodedExplicit !== undefined &&
      decodedEnv !== undefined &&
      decodedExplicit !== decodedEnv
    ) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message:
            `Conflicting run identity: --run=${decodedExplicit} but PITHOS_RUN_ID=${decodedEnv}. ` +
            `Supply one or make them match.`,
        }),
      )
    }

    return decodedExplicit ?? decodedEnv
  })

export const toRunOutput = (run: RunRow) => ({
  id: run.id,
  agent: run.agent_kind,
  mode: run.mode,
  scope_id: run.scope_id,
  status: run.status,
  task_id: run.task_id,
  session_id: run.session_id,
  created_at: run.created_at,
  updated_at: run.updated_at,
})
