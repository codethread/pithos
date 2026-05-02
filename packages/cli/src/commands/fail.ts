import { Effect } from "effect"
import { DbService } from "../services/db.ts"
import { PithosError } from "../errors/errors.ts"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FailOptions {
  readonly taskId: string | undefined
  readonly run: string | undefined
  readonly token: number | undefined
  readonly reason?: string | undefined
}

// ---------------------------------------------------------------------------
// pithos fail
// ---------------------------------------------------------------------------

/**
 * `pithos fail <task-id> --run <run-id> --token <n> [--reason <text>]`
 *
 * Fails a claimed/running task if the run owns the current fencing token.
 * In a single transaction:
 *  - Sets status = 'failed', result_json = { reason }, updated_at
 *  - Appends a task.failed event
 *
 * Exits with code 4 (STALE_TOKEN) when the run/token combination does not
 * match the task's current owner or the task is not in a claimable state.
 */
export const failCommand = (
  opts: FailOptions,
): Effect.Effect<void, PithosError, DbService> =>
  Effect.gen(function* () {
    if (!opts.taskId) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "task id argument is required" }),
      )
      return
    }
    if (!opts.run) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }),
      )
      return
    }
    if (opts.token === undefined) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--token is required" }),
      )
      return
    }
    if (!Number.isFinite(opts.token) || !Number.isInteger(opts.token)) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `--token must be an integer, got: ${String(opts.token)}`,
        }),
      )
      return
    }

    const taskId = opts.taskId
    const runId = opts.run
    const token = opts.token
    const reason = opts.reason ?? ""
    const resultJson = JSON.stringify({ reason })

    const db = yield* DbService

    type TxResult =
      | { readonly kind: "stale_token" }
      | { readonly kind: "success"; readonly task: Record<string, unknown> }

    const txResult = yield* db.transaction((tx): TxResult => {
      const rows = tx.query(
        `UPDATE tasks
         SET
           status     = 'failed',
           result_json = ?,
           updated_at  = datetime('now')
         WHERE id = ?
           AND lease_owner_run_id = ?
           AND fencing_token = ?
           AND status IN ('claimed', 'running')
         RETURNING *`,
        [resultJson, taskId, runId, token],
      )

      if (rows.length === 0) return { kind: "stale_token" }

      const task = rows[0]!

      tx.run(
        `INSERT INTO events (task_id, actor_run_id, type, payload_json)
         VALUES (?, ?, 'task.failed', ?)`,
        [task.id, runId, JSON.stringify({ run_id: runId, fencing_token: token, reason })],
      )

      tx.run(
        `UPDATE runs SET task_id = NULL, updated_at = datetime('now') WHERE id = ?`,
        [runId],
      )

      return { kind: "success", task }
    })

    if (txResult.kind === "stale_token") {
      yield* Effect.fail(
        new PithosError({
          code: "STALE_TOKEN",
          message: `Stale fencing token for task: ${taskId}`,
        }),
      )
      return
    }

    yield* Effect.sync(() => {
      console.log(JSON.stringify({ ok: true, task: txResult.task }))
    })
  })

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const FAIL_HELP = `pithos fail - Fail a claimed/running task with fencing-token check

Usage:
  pithos fail <task-id> --run <run-id> --token <n> [options]

Arguments:
  <task-id>              Task ID to fail [required]

Options:
  --run <run-id>         Run ID that owns the task [required]
  --token <n>            Fencing token from the claim response [required]
  --reason <text>        Human-readable failure reason stored in result_json
  --help, -h             Show this help

Output (JSON, success):
  { "ok": true, "task": { "id": "task_...", "status": "failed", ... } }

Notes:
  - The run must be the current lease owner and the token must match.
  - Any other owner, wrong token, or wrong task status returns exit code 4.
  - The reason string is stored in result_json as { "reason": "..." }.

Examples:
  pithos fail task_abc --run run_xyz --token 1 --reason "worker disappeared"
  pithos fail task_abc --run run_xyz --token 1

Exit codes: 0 success | 2 validation error | 4 stale token
`
