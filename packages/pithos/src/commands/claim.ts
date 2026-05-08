import { Effect, Metric } from "effect"
import { decodeIdRow, decodeTaskRow, loadRequiredRunRow, loadRequiredScopeRow } from "../db/helpers.ts"
import {
  assertCapabilityScopeAllowed,
  assertRunCanClaimCapability,
  decodeCapability,
} from "../domain/auth.ts"
import { TERMINAL_RUN_STATUSES } from "../domain/run.ts"
import { PithosError } from "../errors/errors.ts"
import { tasksClaimedCounter, withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"

export interface ClaimOptions {
  readonly run: string | undefined
  readonly scope: string | undefined
  readonly capability: string | undefined
}

export const claimCommand = (
  opts: ClaimOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    if (opts.run === undefined) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }))
    }
    if (opts.scope === undefined) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--scope is required" }))
    }
    if (opts.capability === undefined) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--capability is required" }),
      )
    }

    const runId = opts.run!
    const scopeId = opts.scope!
    const capability = yield* decodeCapability(opts.capability!)

    const db = yield* DbService
    const output = yield* OutputService

    const claimedTask = yield* db.withTransaction(
      Effect.gen(function* () {
        const run = yield* loadRequiredRunRow(db, runId)
        const scope = yield* loadRequiredScopeRow(db, scopeId)

        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          yield* Effect.fail(
            new PithosError({
              code: "USER_ERROR",
              message: `Run ${runId} is terminal (${run.status}) and cannot claim work`,
            }),
          )
        }

        if (run.scope_id !== scopeId) {
          yield* Effect.fail(
            new PithosError({
              code: "VALIDATION_ERROR",
              message: `Claim scope mismatch: run ${runId} is registered in scope ${run.scope_id}, not ${scopeId}`,
            }),
          )
        }

        if (run.task_id !== null) {
          yield* Effect.fail(
            new PithosError({
              code: "VALIDATION_ERROR",
              message: `Run ${runId} already holds task ${run.task_id}`,
            }),
          )
        }

        yield* assertCapabilityScopeAllowed(capability, scope)
        yield* Effect.provideService(assertRunCanClaimCapability(run, capability), DbService, db)

        const taskRows = yield* db.query(
          `UPDATE tasks
           SET
             status = 'claimed',
             fencing_token = fencing_token + 1,
             attempts = attempts + 1,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = (
             SELECT t.id
             FROM tasks t
             WHERE t.status = 'queued'
               AND t.scope_id = ?
               AND t.capability = ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM task_dependencies td
                 JOIN tasks dep ON dep.id = td.depends_on_task_id
                 WHERE td.task_id = t.id
                   AND dep.status <> 'done'
               )
             ORDER BY t.created_at ASC, t.id ASC
             LIMIT 1
           )
             AND status = 'queued'
           RETURNING *`,
          [scopeId, capability],
        )

        if (taskRows.length === 0) {
          return null
        }

        const task = yield* decodeTaskRow(taskRows[0]!)

        const runRows = yield* db.query(
          `UPDATE runs
           SET task_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND task_id IS NULL
             AND scope_id = ?
           RETURNING id`,
          [task.id, runId, scopeId],
        )
        if (runRows.length === 0) {
          yield* Effect.fail(
            new PithosError({
              code: "VALIDATION_ERROR",
              message: `Run ${runId} can no longer claim work; task ownership changed concurrently`,
            }),
          )
        }
        yield* decodeIdRow(runRows[0]!)
        yield* db.run(
          `INSERT INTO events (task_id, actor_run_id, type, payload_json)
           VALUES (?, ?, 'task.claimed', ?)`,
          [
            task.id,
            runId,
            JSON.stringify({ run_id: runId, fencing_token: task.fencing_token }),
          ],
        )

        return task
      }),
    )

    if (claimedTask === null) {
      yield* Effect.logDebug("no claimable work").pipe(
        Effect.annotateLogs({ scopeId, capability }),
      )
      yield* Effect.fail(
        new PithosError({ code: "NO_CLAIMABLE_WORK", message: "no claimable work found" }),
      )
      return yield* Effect.never
    }

    yield* Metric.increment(tasksClaimedCounter)
    yield* Effect.logDebug("task claimed").pipe(
      Effect.annotateLogs({ taskId: claimedTask.id, runId }),
    )
    yield* output.print(JSON.stringify({ ok: true, task: claimedTask }))
  }).pipe(Effect.withLogSpan("pithos.task.claim"), withCommandObservability("task.claim"))
