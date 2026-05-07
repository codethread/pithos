import { Effect, Metric, Schema } from "effect"
import { decodeRunRow, decodeTaskRow } from "../db/helpers.ts"
import { PithosError } from "../errors/errors.ts"
import {
  heartbeatsWrittenCounter,
  staleTokensHeartbeatCounter,
  withCommandObservability,
} from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"

class TaskStatusRow extends Schema.Class<TaskStatusRow>("TaskStatusRow")({
  status: Schema.String,
}) {}

const decodeTaskStatusRow = (row: unknown): Effect.Effect<TaskStatusRow, PithosError> =>
  Schema.decodeUnknown(TaskStatusRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "task status row shape violation",
        }),
    ),
  )

export interface HeartbeatOptions {
  readonly run: string | undefined
  readonly task?: string | undefined
  readonly token?: number | undefined
}

export const heartbeatCommand = (
  opts: HeartbeatOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    if (opts.run === undefined) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }))
    }

    const hasTask = opts.task !== undefined
    const hasToken = opts.token !== undefined
    if (hasTask !== hasToken) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "--task and --token must be supplied together",
        }),
      )
    }

    if (opts.token !== undefined) {
      yield* Schema.decodeUnknown(Schema.Int)(opts.token).pipe(
        Effect.mapError(
          () =>
            new PithosError({
              code: "VALIDATION_ERROR",
              message: `--token must be an integer, got: ${String(opts.token)}`,
            }),
        ),
      )
    }

    const runId = opts.run
    const db = yield* DbService
    const output = yield* OutputService

    const txResult = yield* db.withTransaction(
      Effect.gen(function* () {
        const runRows = yield* db.query(`SELECT * FROM runs WHERE id = ?`, [runId])
        if (runRows.length === 0) {
          return { kind: "not_found" as const }
        }

        const beforeRun = yield* decodeRunRow(runRows[0]!)
        const nextRunStatus = beforeRun.status === "starting" ? "running" : beforeRun.status

        if (opts.task !== undefined && opts.token !== undefined) {
          const taskStateRows = yield* db.query(
            `SELECT status
             FROM tasks
             WHERE id = ?
               AND fencing_token = ?
               AND status IN ('claimed', 'running')
               AND EXISTS (
                 SELECT 1
                 FROM runs
                 WHERE id = ?
                   AND task_id = tasks.id
               )`,
            [opts.task, opts.token, runId],
          )
          if (taskStateRows.length === 0) {
            return { kind: "stale_token" as const }
          }

          const previousTask = yield* decodeTaskStatusRow(taskStateRows[0]!)
          const taskRows = yield* db.query(
            `UPDATE tasks
             SET
               status = CASE WHEN status = 'claimed' THEN 'running' ELSE status END,
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
            [opts.task, opts.token, runId],
          )
          if (taskRows.length === 0) {
            yield* Effect.fail(
              new PithosError({
                code: "STALE_TOKEN",
                message: "concurrent task update invalidated the heartbeat token",
              }),
            )
          }

          const task = yield* decodeTaskRow(taskRows[0]!)
          yield* db.run(
            `UPDATE runs
             SET
               status = ?,
               last_heartbeat_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [nextRunStatus, runId],
          )
          yield* db.run(
            `INSERT INTO events (task_id, actor_run_id, run_id, type, payload_json)
             VALUES (?, ?, ?, 'task.heartbeat', ?)`,
            [
              task.id,
              runId,
              runId,
              JSON.stringify({
                run_id: runId,
                fencing_token: task.fencing_token,
                previous_status: previousTask.status,
                status: task.status,
              }),
            ],
          )

          return { kind: "task" as const, task }
        }

        yield* db.run(
          `UPDATE runs
           SET
             status = ?,
             last_heartbeat_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [nextRunStatus, runId],
        )
        yield* db.run(
          `INSERT INTO events (run_id, type, payload_json)
           VALUES (?, 'run.heartbeat', ?)`,
          [runId, JSON.stringify({ status: nextRunStatus })],
        )

        return { kind: "run" as const }
      }),
    ).pipe(
      Effect.tapError((error) =>
        error.code === "STALE_TOKEN"
          ? Effect.all([
              Metric.increment(staleTokensHeartbeatCounter),
              Effect.logWarning("stale fencing token race on heartbeat").pipe(
                Effect.annotateLogs({
                  runId,
                  taskId: String(opts.task ?? ""),
                  token: String(opts.token ?? ""),
                }),
              ),
            ])
          : Effect.void,
      ),
    )

    if (txResult.kind === "not_found") {
      yield* Effect.fail(new PithosError({ code: "NOT_FOUND", message: `Run not found: ${runId}` }))
    }

    if (txResult.kind === "stale_token") {
      yield* Metric.increment(staleTokensHeartbeatCounter)
      yield* Effect.logWarning("stale fencing token rejected on heartbeat").pipe(
        Effect.annotateLogs({ runId, taskId: String(opts.task ?? ""), token: String(opts.token ?? "") }),
      )
      yield* Effect.fail(
        new PithosError({
          code: "STALE_TOKEN",
          message: `Stale fencing token for task: ${opts.task ?? ""}`,
        }),
      )
    }

    const runRows = yield* db.query(`SELECT * FROM runs WHERE id = ?`, [runId])
    const run = yield* decodeRunRow(runRows[0]!)

    yield* Metric.increment(heartbeatsWrittenCounter)
    if (txResult.kind === "task") {
      yield* output.print(JSON.stringify({ ok: true, skipped: false, run, task: txResult.task }))
      return
    }

    yield* output.print(JSON.stringify({ ok: true, skipped: false, run }))
  }).pipe(Effect.withLogSpan("pithos.task.heartbeat"), withCommandObservability("task.heartbeat"))
