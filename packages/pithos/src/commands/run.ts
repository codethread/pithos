import { Effect, Schema } from "effect"
import { decodeRunMode, decodeAgentKind } from "../domain/auth.ts"
import { toRunOutput } from "../domain/run.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { IdService } from "../services/ids.ts"
import { OutputService } from "../services/output.ts"
import { decodeRunRow, loadRequiredScopeRow } from "../db/helpers.ts"

export interface RunUpsertOptions {
  readonly agent: string | undefined
  readonly mode: string | undefined
  readonly scope: string | undefined
  readonly cwd: string | undefined
  readonly sessionId: string | undefined
  readonly run?: string | undefined
}

const NonEmptyString = Schema.NonEmptyString

const decodeRequiredText = (
  raw: string | undefined,
  name: string,
): Effect.Effect<string, PithosError> =>
  raw === undefined
    ? Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: `${name} is required` }))
    : Schema.decodeUnknown(NonEmptyString)(raw).pipe(
        Effect.mapError(
          () =>
            new PithosError({
              code: "VALIDATION_ERROR",
              message: `${name} must be a non-empty string`,
            }),
        ),
      )

export const runUpsertCommand = (
  opts: RunUpsertOptions,
): Effect.Effect<void, PithosError, DbService | IdService | OutputService> =>
  Effect.gen(function* () {
    const agent = yield* decodeAgentKind(opts.agent)
    const mode = yield* decodeRunMode(opts.mode)
    const scopeId = yield* decodeRequiredText(opts.scope, "--scope")
    const cwd = yield* decodeRequiredText(opts.cwd, "--cwd")
    const sessionId = yield* decodeRequiredText(opts.sessionId, "--session-id")
    const explicitRunId =
      opts.run === undefined ? undefined : yield* decodeRequiredText(opts.run, "--run")

    const db = yield* DbService
    const ids = yield* IdService
    const output = yield* OutputService

    yield* loadRequiredScopeRow(db, scopeId)

    const runId = explicitRunId ?? (yield* ids.generate("run"))
    const run = yield* db.withTransaction(
      Effect.gen(function* () {
        const existingRows = yield* db.query(`SELECT * FROM runs WHERE id = ?`, [runId])
        if (existingRows.length > 0) {
          const existing = yield* decodeRunRow(existingRows[0]!)
          const mismatches = [
            ["agent", existing.agent_kind, agent],
            ["mode", existing.mode, mode],
            ["scope", existing.scope_id, scopeId],
            ["cwd", existing.cwd, cwd],
            ["session-id", existing.session_id, sessionId],
          ].filter(([, actual, expected]) => actual !== expected)

          if (mismatches.length > 0) {
            yield* Effect.fail(
              new PithosError({
                code: "VALIDATION_ERROR",
                message:
                  `Run ${runId} already exists with different immutable fields: ` +
                  mismatches
                    .map(([field, actual, expected]) => `${field}=${JSON.stringify(actual)} (wanted ${JSON.stringify(expected)})`)
                    .join(", "),
              }),
            )
          }

          return existing
        }

        const insertedRows = yield* db.query(
          `INSERT INTO runs
             (id, agent_kind, mode, scope_id, task_id, harness, session_id, tmux_target, cwd, status, last_heartbeat_at, metadata_json, ended_at)
           VALUES (?, ?, ?, ?, NULL, 'claude-code', ?, NULL, ?, 'starting', NULL, '{}', NULL)
           RETURNING *`,
          [runId, agent, mode, scopeId, sessionId, cwd],
        )

        if (insertedRows.length === 0) {
          yield* Effect.fail(
            new PithosError({
              code: "INTERNAL_ERROR",
              message: `run upsert returned no row for ${runId}`,
            }),
          )
        }

        return yield* decodeRunRow(insertedRows[0]!)
      }),
    )
    yield* Effect.logDebug("run upserted").pipe(
      Effect.annotateLogs({ runId, agent, mode, scopeId }),
    )
    yield* output.print(JSON.stringify({ ok: true, run: toRunOutput(run) }))
  }).pipe(Effect.withLogSpan("pithos.run.upsert"), withCommandObservability("run.upsert"))
