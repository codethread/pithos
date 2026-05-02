import { Effect, Metric } from "effect"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"
import {
  heartbeatsWrittenCounter,
  heartbeatsThrottledCounter,
  staleTokensHeartbeatCounter,
  withCommandObservability,
} from "../layers/metrics.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIFECYCLE_HOOKS = new Set(["SessionStart", "SessionEnd", "Stop", "StopFailure"])
const LEASE_EXTENSION_MINUTES = 10

/**
 * Normalize a SQLite datetime string (e.g. "2026-05-01 23:32:37") to a
 * valid ISO-8601 UTC string so JavaScript's Date constructor parses it as
 * UTC rather than local time.
 */
const normalizeSqliteUtc = (dt: string): string => {
  if (dt.endsWith("Z") || dt.includes("T")) return dt
  return dt.replace(" ", "T") + "Z"
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface HeartbeatOptions {
  readonly run: string | undefined
  readonly task?: string | undefined
  readonly token?: number | undefined
  readonly hook?: string | undefined
  readonly throttleSeconds?: number | undefined
}

// ---------------------------------------------------------------------------
// pithos heartbeat
// ---------------------------------------------------------------------------

/**
 * `pithos heartbeat --run <run-id> [--task <task-id>] [--token <n>]
 *                   [--hook <hook-name>] [--throttle-seconds <n>]`
 *
 * Updates mutable run heartbeat state:
 *  - Sets `last_heartbeat_at = now`, `last_hook = ?`
 *  - Advances `status` from 'starting' to 'running' if still starting
 *
 * When `--task` + `--token` are also given:
 *  - Fencing token is validated before any writes and before throttle check
 *  - Moves task from 'claimed' to 'running' if fencing token matches
 *  - Extends `lease_until` by LEASE_EXTENSION_MINUTES
 *  - Fails with code STALE_TOKEN (4) if the fencing token does not match
 *
 * When `--throttle-seconds N` is given:
 *  - Compares now against `runs.last_heartbeat_at`
 *  - If last heartbeat is newer than N seconds, skips all writes and returns
 *    `{ ok: true, skipped: true }`, UNLESS `--hook` is a lifecycle boundary
 *    (SessionStart, SessionEnd, Stop, StopFailure)
 *  - Token is always validated first regardless of throttle
 *
 * Exits with code 3 (NOT_FOUND) when the run does not exist.
 * Exits with code 4 (STALE_TOKEN) when the fencing token is rejected.
 */
export const heartbeatCommand = (
  opts: HeartbeatOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    if (!opts.run) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }),
      )
      return
    }

    if (opts.task !== undefined && opts.token === undefined) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "--token is required when --task is provided",
        }),
      )
      return
    }

    if (opts.token !== undefined && (!Number.isFinite(opts.token) || !Number.isInteger(opts.token))) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `--token must be an integer, got: ${String(opts.token)}`,
        }),
      )
      return
    }

    if (
      opts.throttleSeconds !== undefined &&
      (!Number.isFinite(opts.throttleSeconds) || opts.throttleSeconds < 0)
    ) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `--throttle-seconds must be a non-negative number, got: ${String(opts.throttleSeconds)}`,
        }),
      )
      return
    }

    const runId = opts.run
    const hook = opts.hook ?? null

    const db = yield* DbService
    const output = yield* OutputService

    type TxResult =
      | { readonly kind: "not_found" }
      | { readonly kind: "throttled" }
      | { readonly kind: "stale_token" }
      | { readonly kind: "success" }
      | { readonly kind: "success_with_task"; readonly task: Record<string, unknown> }

    const txResult = yield* db.transaction((tx): TxResult => {
      // 1. Check run exists
      const runRows = tx.query(
        "SELECT id, status, last_heartbeat_at FROM runs WHERE id = ?",
        [runId],
      )
      if (runRows.length === 0) return { kind: "not_found" }

      const run = runRows[0]!
      const lastHeartbeatAt = run.last_heartbeat_at as string | null

      // 2. If task+token provided, validate fencing token BEFORE throttle and
      //    BEFORE any writes — stale token is always rejected even when throttled.
      if (opts.task !== undefined && opts.token !== undefined) {
        const tokenRows = tx.query(
          `SELECT id FROM tasks
           WHERE id = ?
             AND lease_owner_run_id = ?
             AND fencing_token = ?
             AND status IN ('claimed', 'running')`,
          [opts.task, runId, opts.token],
        )
        if (tokenRows.length === 0) return { kind: "stale_token" }
      }

      // 3. Check throttle — skip writes if within window and not a lifecycle boundary
      if (opts.throttleSeconds !== undefined && lastHeartbeatAt !== null) {
        const isLifecycle = hook !== null && LIFECYCLE_HOOKS.has(hook)
        if (!isLifecycle) {
          const elapsedSeconds =
            (Date.now() - new Date(normalizeSqliteUtc(lastHeartbeatAt)).getTime()) / 1000
          if (elapsedSeconds < opts.throttleSeconds) {
            return { kind: "throttled" }
          }
        }
      }

      // 4. If task+token provided, UPDATE task FIRST so the run write only
      //    happens after we know the token is still valid.  If the UPDATE
      //    finds 0 rows (token invalidated between the pre-check and now),
      //    throw a sentinel so better-sqlite3 rolls back the whole transaction
      //    (nothing has been written yet at this point).
      if (opts.task !== undefined && opts.token !== undefined) {
        const taskRows = tx.query(
          `UPDATE tasks
           SET
             status      = 'running',
             lease_until = strftime('%Y-%m-%dT%H:%M:%SZ',
                             datetime('now', '+${String(LEASE_EXTENSION_MINUTES)} minutes')),
             updated_at  = datetime('now')
           WHERE id = ?
             AND lease_owner_run_id = ?
             AND fencing_token = ?
             AND status IN ('claimed', 'running')
           RETURNING *`,
          [opts.task, runId, opts.token],
        )
        if (taskRows.length === 0) {
          // Pre-check passed but UPDATE found no row: concurrent reclaim/sweep
          // invalidated the token between steps 2 and 4.  Throw to roll back
          // the entire transaction (no writes committed yet).
          throw new Error("PITHOS_STALE_TOKEN_RACE")
        }

        // 5. Task write succeeded — now update run heartbeat.
        tx.run(
          `UPDATE runs
           SET
             status            = CASE WHEN status = 'starting' THEN 'running' ELSE status END,
             last_heartbeat_at = datetime('now'),
             last_hook         = ?,
             updated_at        = datetime('now')
           WHERE id = ?`,
          [hook, runId],
        )

        return { kind: "success_with_task", task: taskRows[0]! }
      }

      // 4b. No task — update run heartbeat unconditionally.
      tx.run(
        `UPDATE runs
         SET
           status            = CASE WHEN status = 'starting' THEN 'running' ELSE status END,
           last_heartbeat_at = datetime('now'),
           last_hook         = ?,
           updated_at        = datetime('now')
         WHERE id = ?`,
        [hook, runId],
      )

      return { kind: "success" }
    })

    if (txResult.kind === "not_found") {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Run not found: ${runId}` }),
      )
      return
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
      return
    }

    // Re-read the updated run for the response
    const runRows = yield* db.query("SELECT * FROM runs WHERE id = ?", [runId])
    const run = runRows[0]!

    if (txResult.kind === "throttled") {
      yield* Metric.increment(heartbeatsThrottledCounter)
      yield* Effect.logDebug("heartbeat throttled").pipe(
        Effect.annotateLogs({ runId, throttleSeconds: String(opts.throttleSeconds ?? "") }),
      )
      yield* output.print(JSON.stringify({ ok: true, skipped: true, run }))
      return
    }

    if (txResult.kind === "success_with_task") {
      yield* Metric.increment(heartbeatsWrittenCounter)
      yield* Effect.logDebug("heartbeat written with task advance").pipe(
        Effect.annotateLogs({ runId, taskId: String(opts.task ?? "") }),
      )
      yield* output.print(
        JSON.stringify({ ok: true, skipped: false, run, task: txResult.task }),
      )
      return
    }

    yield* Metric.increment(heartbeatsWrittenCounter)
    yield* Effect.logDebug("heartbeat written").pipe(
      Effect.annotateLogs({ runId }),
    )
    yield* output.print(JSON.stringify({ ok: true, skipped: false, run }))
  }).pipe(
    Effect.withLogSpan("pithos.heartbeat"),
    withCommandObservability("heartbeat"),
  )

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const HEARTBEAT_HELP = `pithos heartbeat - Update mutable run heartbeat; optionally advance task to running

Usage:
  pithos heartbeat --run <run-id> [options]

Options:
  --run <run-id>             Run ID to heartbeat [required]
  --task <task-id>           Task ID to advance from claimed to running
  --token <n>                Fencing token for the claimed task [required with --task]
  --hook <hook-name>         Hook name, e.g. PreToolUse, SessionStart, SessionEnd, Stop, StopFailure
  --throttle-seconds <n>     Skip writes if last heartbeat is newer than N seconds
                             (lifecycle hooks bypass throttle: SessionStart, SessionEnd, Stop, StopFailure)
  --help, -h                 Show this help

Output (JSON, written):
  { "ok": true, "skipped": false, "run": { ... } }
  { "ok": true, "skipped": false, "run": { ... }, "task": { ... } }   (when --task given)

Output (JSON, throttled):
  { "ok": true, "skipped": true, "run": { ... } }

Notes:
  - Advances run status from 'starting' to 'running' on first heartbeat.
  - When --task + --token: moves task from 'claimed' to 'running' and extends lease by ${String(LEASE_EXTENSION_MINUTES)} minutes.
  - Stale token rejects the heartbeat (exit code 4); no state is mutated.
  - Stale token is rejected even inside a throttle window.
  - Throttled heartbeats return exit code 0 with skipped:true.

Examples:
  pithos heartbeat --run run_abc
  pithos heartbeat --run run_abc --hook PreToolUse --throttle-seconds 60
  pithos heartbeat --run run_abc --task task_xyz --token 1 --hook UserPromptSubmit

Exit codes: 0 success (including throttled) | 2 validation error | 3 not found | 4 stale token
`
