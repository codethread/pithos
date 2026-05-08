import { Effect, Metric, Schema } from "effect"
import { decodeIdRow, decodeTaskRow } from "../db/helpers.ts"
import { PithosError } from "../errors/errors.ts"
import { staleTokensFailCounter, withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"

export interface FailOptions {
  readonly taskId: string | undefined
  readonly run: string | undefined
  readonly token: number | undefined
  readonly reason: string | undefined
}

export const failCommand = (
  opts: FailOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    if (!opts.taskId) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "task id argument is required" }),
      )
    }
    if (!opts.run) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }))
    }
    if (opts.token === undefined) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--token is required" }))
    }
    yield* Schema.decodeUnknown(Schema.Int)(opts.token).pipe(
      Effect.mapError(
        () =>
          new PithosError({
            code: "VALIDATION_ERROR",
            message: `--token must be an integer, got: ${String(opts.token)}`,
          }),
      ),
    )

    const rawReason = opts.reason
    if (rawReason === undefined || rawReason.trim().length === 0) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--reason is required" }))
    }

    const taskId = opts.taskId
    const runId = opts.run
    const token = opts.token
    const reason = rawReason!
    const trimmedReason = reason.trim()
    const resultJson = JSON.stringify({ reason: trimmedReason })
    const db = yield* DbService
    const output = yield* OutputService

    const txResult = yield* db.withTransaction(
      Effect.gen(function* () {
        const taskRows = yield* db.query(
          `UPDATE tasks
           SET
             status = 'failed',
             result_json = ?,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND fencing_token = ?
             AND status IN ('claimed', 'running')
             AND EXISTS (
               SELECT 1
               FROM runs
               WHERE id = ?
                 AND task_id = tasks.id
             )
           RETURNING *`,
          [resultJson, taskId, token, runId],
        )
        if (taskRows.length === 0) {
          return { kind: "stale_token" as const }
        }

        const task = yield* decodeTaskRow(taskRows[0]!)
        yield* db.run(
          `INSERT INTO events (task_id, actor_run_id, run_id, type, payload_json)
           VALUES (?, ?, ?, 'task.failed', ?)`,
          [
            task.id,
            runId,
            runId,
            JSON.stringify({ run_id: runId, fencing_token: token, reason: trimmedReason }),
          ],
        )

        const runRows = yield* db.query(
          `UPDATE runs
           SET task_id = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND task_id = ?
           RETURNING id`,
          [runId, taskId],
        )
        if (runRows.length !== 1) {
          yield* Effect.fail(
            new PithosError({
              code: "STALE_TOKEN",
              message: "concurrent run state change invalidated task failure",
            }),
          )
        }
        yield* decodeIdRow(runRows[0]!)

        return { kind: "success" as const, task }
      }),
    )

    if (txResult.kind === "stale_token") {
      yield* Metric.increment(staleTokensFailCounter)
      yield* Effect.logWarning("stale fencing token rejected on fail").pipe(
        Effect.annotateLogs({ taskId, runId, token: String(token) }),
      )
      yield* Effect.fail(
        new PithosError({ code: "STALE_TOKEN", message: `Stale fencing token for task: ${taskId}` }),
      )
    }

    yield* Effect.logDebug("task failed").pipe(Effect.annotateLogs({ taskId, runId }))
    yield* output.print(JSON.stringify({ ok: true, task: txResult.task }))
  }).pipe(Effect.withLogSpan("pithos.task.fail"), withCommandObservability("task.fail"))
