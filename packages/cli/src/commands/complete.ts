import { Effect } from "effect"
import { DbService } from "../services/db.ts"
import { FsService } from "../services/fs.ts"
import { PithosError } from "../errors/errors.ts"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CompleteOptions {
  readonly taskId: string | undefined
  readonly run: string | undefined
  readonly token: number | undefined
  readonly resultFile?: string | undefined
}

// ---------------------------------------------------------------------------
// pithos complete
// ---------------------------------------------------------------------------

/**
 * `pithos complete <task-id> --run <run-id> --token <n> [--result-file <path>]`
 *
 * Completes a claimed/running task if the run owns the current fencing token.
 * In a single transaction:
 *  - Sets status = 'done', result_json, completed_at
 *  - Appends a task.completed event
 *
 * Exits with code 4 (STALE_TOKEN) when the run/token combination does not
 * match the task's current owner or the task is not in a claimable state.
 */
export const completeCommand = (
  opts: CompleteOptions,
): Effect.Effect<void, PithosError, DbService | FsService> =>
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

    // Read result JSON from --result-file if provided; validate JSON.
    const fs = yield* FsService
    let resultJson = "{}"
    if (opts.resultFile) {
      const raw = yield* fs.readFile(opts.resultFile)
      try {
        JSON.parse(raw)
        resultJson = raw.trim()
      } catch {
        yield* Effect.fail(
          new PithosError({
            code: "VALIDATION_ERROR",
            message: `--result-file does not contain valid JSON: ${opts.resultFile}`,
          }),
        )
        return
      }
    }

    const db = yield* DbService

    type TxResult =
      | { readonly kind: "stale_token" }
      | { readonly kind: "success"; readonly task: Record<string, unknown> }

    const txResult = yield* db.transaction((tx): TxResult => {
      const rows = tx.query(
        `UPDATE tasks
         SET
           status       = 'done',
           result_json  = ?,
           completed_at = datetime('now'),
           updated_at   = datetime('now')
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
         VALUES (?, ?, 'task.completed', ?)`,
        [task.id, runId, JSON.stringify({ run_id: runId, fencing_token: token })],
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

export const COMPLETE_HELP = `pithos complete - Complete a claimed/running task with fencing-token check

Usage:
  pithos complete <task-id> --run <run-id> --token <n> [options]

Arguments:
  <task-id>              Task ID to complete [required]

Options:
  --run <run-id>         Run ID that owns the task [required]
  --token <n>            Fencing token from the claim response [required]
  --result-file <path>   Path to a JSON file to store as the task result
  --help, -h             Show this help

Output (JSON, success):
  { "ok": true, "task": { "id": "task_...", "status": "done", "completed_at": "...", ... } }

Notes:
  - The run must be the current lease owner and the token must match.
  - Any other owner, wrong token, or wrong task status returns exit code 4.
  - result-file must be valid JSON; its content is stored in result_json.

Examples:
  pithos complete task_abc --run run_xyz --token 1
  pithos complete task_abc --run run_xyz --token 1 --result-file ./result.json

Exit codes: 0 success | 2 validation error | 4 stale token
`
