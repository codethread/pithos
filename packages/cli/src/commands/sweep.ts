import { Effect, Metric, Schema } from "effect"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"
import { TaskRow } from "../db/rows.ts"
import { sweepDeadLetteredCounter, sweepRequeuedCounter, withCommandObservability } from "../layers/metrics.ts"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SweepOptions {
  readonly leaseGraceSeconds?: number | undefined
  readonly runStaleMinutes?: number | undefined
}

const DEFAULT_LEASE_GRACE_SECONDS = 0
const DEFAULT_RUN_STALE_MINUTES = 15

// ---------------------------------------------------------------------------
// pithos sweep
// ---------------------------------------------------------------------------

/**
 * `pithos sweep [--lease-grace-seconds <n>] [--run-stale-minutes <n>]`
 *
 * Deterministic cleanup sweep:
 *  1. Finds claimed/running tasks with expired lease_until.
 *     - If attempts < max_attempts: requeues (status = 'queued', clears lease) + event task.requeued
 *     - If attempts >= max_attempts: dead-letters (status = 'dead_letter') + event task.dead_lettered
 *  2. Marks runs stale if last_heartbeat_at (or created_at if no heartbeat) is older than runStaleMinutes.
 *
 * All mutations run inside a single transaction.
 * Does not kill tmux sessions or spawn agents.
 */
export const sweepCommand = (
  opts: SweepOptions = {},
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const leaseGraceSeconds = opts.leaseGraceSeconds ?? DEFAULT_LEASE_GRACE_SECONDS
    const runStaleMinutes = opts.runStaleMinutes ?? DEFAULT_RUN_STALE_MINUTES

    if (!Number.isFinite(leaseGraceSeconds) || leaseGraceSeconds < 0) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `--lease-grace-seconds must be a non-negative number, got: ${String(leaseGraceSeconds)}`,
        }),
      )
      return
    }

    if (!Number.isFinite(runStaleMinutes) || runStaleMinutes <= 0) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `--run-stale-minutes must be a positive number, got: ${String(runStaleMinutes)}`,
        }),
      )
      return
    }

    const db = yield* DbService
    const output = yield* OutputService

    const result = yield* db.withTransaction(
      Effect.gen(function* () {
        // Step 1: Find expired claimed/running tasks.
        // A task is expired when lease_until < now - leaseGraceSeconds.
        const expiredRows = yield* db.query(
          `SELECT * FROM tasks
           WHERE status IN ('claimed', 'running')
             AND lease_until IS NOT NULL
             AND lease_until < strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-' || ? || ' seconds'))`,
          [leaseGraceSeconds],
        )

        let requeued = 0
        let deadLettered = 0

        for (const row of expiredRows) {
          const task = yield* Schema.decodeUnknown(TaskRow)(row).pipe(
            Effect.mapError(
              () =>
                new PithosError({
                  code: "INTERNAL_ERROR",
                  message: "TaskRow shape violation from DB during sweep",
                }),
            ),
          )

          if (task.attempts < task.max_attempts) {
            // Requeue: clear lease fields and reset status to 'queued'.
            const requeuedRows = yield* db.query(
              `UPDATE tasks
               SET
                 status             = 'queued',
                 lease_owner_run_id = NULL,
                 lease_until        = NULL,
                 updated_at         = datetime('now')
               WHERE id = ?
                 AND status IN ('claimed', 'running')
               RETURNING id`,
              [task.id],
            )

            if (requeuedRows.length === 0) {
              // Concurrent modification invalidated the row between SELECT and UPDATE.
              // Throw to roll back the whole transaction.
              return yield* Effect.fail(
                new PithosError({
                  code: "INTERNAL_ERROR",
                  message: `Concurrent modification during sweep requeue of task: ${task.id}`,
                }),
              )
            }

            yield* db.run(
              `INSERT INTO events (task_id, actor_run_id, type, payload_json)
               VALUES (?, NULL, 'task.requeued', ?)`,
              [
                task.id,
                JSON.stringify({
                  previous_run_id: task.lease_owner_run_id,
                  attempts: task.attempts,
                  max_attempts: task.max_attempts,
                }),
              ],
            )

            requeued++
          } else {
            // Dead-letter: attempts exhausted.
            const deadRows = yield* db.query(
              `UPDATE tasks
               SET
                 status     = 'dead_letter',
                 updated_at = datetime('now')
               WHERE id = ?
                 AND status IN ('claimed', 'running')
               RETURNING id`,
              [task.id],
            )

            if (deadRows.length === 0) {
              // Concurrent modification invalidated the row between SELECT and UPDATE.
              return yield* Effect.fail(
                new PithosError({
                  code: "INTERNAL_ERROR",
                  message: `Concurrent modification during sweep dead-letter of task: ${task.id}`,
                }),
              )
            }

            yield* db.run(
              `INSERT INTO events (task_id, actor_run_id, type, payload_json)
               VALUES (?, NULL, 'task.dead_lettered', ?)`,
              [
                task.id,
                JSON.stringify({
                  previous_run_id: task.lease_owner_run_id,
                  attempts: task.attempts,
                  max_attempts: task.max_attempts,
                }),
              ],
            )

            deadLettered++
          }
        }

        // Step 2: Mark stale runs.
        // A run is stale when it is in an active state and its last heartbeat
        // (or created_at if no heartbeat has been recorded) is older than runStaleMinutes.
        const staleRunRows = yield* db.query(
          `UPDATE runs
           SET
             status     = 'stale',
             updated_at = datetime('now')
           WHERE status IN ('starting', 'running', 'idle')
             AND (
               (last_heartbeat_at IS NOT NULL
                AND last_heartbeat_at < strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-' || ? || ' minutes')))
               OR
               (last_heartbeat_at IS NULL
                AND created_at < strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-' || ? || ' minutes')))
             )
           RETURNING id`,
          [runStaleMinutes, runStaleMinutes],
        )

        return { requeued, deadLettered, staleRuns: staleRunRows.length }
      }),
    )

    // Update metrics after the transaction commits.
    yield* Metric.update(sweepRequeuedCounter, result.requeued)
    yield* Metric.update(sweepDeadLetteredCounter, result.deadLettered)

    yield* Effect.logDebug("sweep completed").pipe(
      Effect.annotateLogs({
        requeued: String(result.requeued),
        deadLettered: String(result.deadLettered),
        staleRuns: String(result.staleRuns),
      }),
    )

    yield* output.print(
      JSON.stringify({
        ok: true,
        requeued: result.requeued,
        dead_lettered: result.deadLettered,
        stale_runs: result.staleRuns,
      }),
    )
  }).pipe(
    Effect.withLogSpan("pithos.sweep"),
    withCommandObservability("sweep"),
  )

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const SWEEP_HELP = `pithos sweep - Expire leases, mark stale runs, requeue or dead-letter tasks

Usage:
  pithos sweep [options]

Options:
  --lease-grace-seconds <n>   Grace period past lease_until before a task is considered expired (default: 0)
  --run-stale-minutes <n>     Minutes since last heartbeat before a run is marked stale (default: 15)
  --help, -h                  Show this help

Output (JSON):
  { "ok": true, "requeued": <n>, "dead_lettered": <n>, "stale_runs": <n> }

Behaviour:
  1. Finds claimed/running tasks with an expired lease_until.
     - If attempts < max_attempts: resets status to 'queued', clears lease fields, appends task.requeued event.
     - If attempts >= max_attempts: sets status to 'dead_letter', appends task.dead_lettered event.
  2. Finds runs in starting/running/idle status whose last heartbeat (or created_at when no heartbeat
     has been recorded) is older than --run-stale-minutes, and marks them 'stale'.

Notes:
  - Does not kill tmux sessions or spawn new agents.
  - All mutations run inside a single transaction.
  - Safe to run from cron/launchd; idempotent when there is nothing to sweep.

Examples:
  pithos sweep
  pithos sweep --lease-grace-seconds 30 --run-stale-minutes 20

Exit codes: 0 success | 2 validation error
`
