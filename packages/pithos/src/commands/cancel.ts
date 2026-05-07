import { Effect } from "effect"
import { decodeTaskRow, loadRequiredRunRow, loadRequiredTaskRow } from "../db/helpers.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"

export interface CancelOptions {
  readonly taskId: string | undefined
  readonly run: string | undefined
  readonly reason: string | undefined
}

export const cancelCommand = (
  opts: CancelOptions,
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
    if (opts.reason === undefined || opts.reason.trim().length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--reason is required" }),
      )
    }

    const taskId = opts.taskId!
    const runId = opts.run!
    const reason = opts.reason!.trim()

    const db = yield* DbService
    const output = yield* OutputService

    const task = yield* db.withTransaction(
      Effect.gen(function* () {
        yield* loadRequiredRunRow(db, runId)
        const task = yield* loadRequiredTaskRow(db, taskId)

        switch (task.status) {
          case "queued":
          case "failed":
          case "dead_letter":
            break
          case "claimed":
          case "running":
            yield* Effect.fail(
              new PithosError({
                code: "USER_ERROR",
                message: `Cannot cancel task ${taskId} while it is ${task.status}; use pdx kill / pithos run interrupt`,
              }),
            )
            break
          case "done":
            yield* Effect.fail(
              new PithosError({
                code: "USER_ERROR",
                message: `Cannot cancel task ${taskId} because it is done`,
              }),
            )
            break
          case "cancelled":
            yield* Effect.fail(
              new PithosError({
                code: "USER_ERROR",
                message: `Task ${taskId} is already cancelled`,
              }),
            )
            break
        }

        const updatedRows = yield* db.query(
          `UPDATE tasks
           SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND status = ?
           RETURNING *`,
          [taskId, task.status],
        )
        if (updatedRows.length !== 1) {
          yield* Effect.fail(
            new PithosError({
              code: "USER_ERROR",
              message: `Task ${taskId} changed state before cancellation completed`,
            }),
          )
        }

        const cancelledTask = yield* decodeTaskRow(updatedRows[0]!)
        yield* db.run(
          `INSERT INTO events (task_id, actor_run_id, type, payload_json)
           VALUES (?, ?, 'task.cancelled', ?)`,
          [taskId, runId, JSON.stringify({ reason })],
        )
        return cancelledTask
      }),
    )

    yield* output.print(JSON.stringify({ ok: true, task }))
  }).pipe(Effect.withLogSpan("pithos.task.cancel"), withCommandObservability("task.cancel"))
