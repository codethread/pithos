import { Effect } from "effect"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ClaimOptions {
  readonly run: string | undefined
  readonly scope: string | undefined
  readonly capability: string | undefined
  readonly leaseMinutes?: number | undefined
}

const DEFAULT_LEASE_MINUTES = 10

// ---------------------------------------------------------------------------
// pithos claim
// ---------------------------------------------------------------------------

/**
 * `pithos claim --run <run-id> --scope <scope-id> --capability <cap> [--lease-minutes <n>]`
 *
 * Atomically claims the oldest queued task matching the scope and capability.
 * In a single transaction:
 *  - Sets status = 'claimed', lease_owner_run_id, lease_until
 *  - Increments fencing_token and attempts
 *  - Appends a task.claimed event
 *
 * Exits with code 5 (NO_CLAIMABLE_WORK) when no matching queued task exists.
 * Exits with code 3 (NOT_FOUND) when the specified run does not exist.
 */
export const claimCommand = (
  opts: ClaimOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    if (!opts.run) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }),
      )
      return
    }
    if (!opts.scope) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--scope is required" }),
      )
      return
    }
    if (!opts.capability) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--capability is required" }),
      )
      return
    }

    const runId = opts.run
    const scope = opts.scope
    const capability = opts.capability
    const leaseMinutes = opts.leaseMinutes ?? DEFAULT_LEASE_MINUTES

    if (!Number.isFinite(leaseMinutes) || leaseMinutes <= 0) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `--lease-minutes must be a positive number, got: ${String(leaseMinutes)}`,
        }),
      )
      return
    }

    const db = yield* DbService
    const output = yield* OutputService

    // Validate run exists before attempting the claim transaction.
    const runRows = yield* db.query(`SELECT id FROM runs WHERE id = ?`, [runId])
    if (runRows.length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Run not found: ${runId}` }),
      )
      return
    }

    // Atomic claim: single transaction, no select-then-update race.
    // tx.query uses .all() which returns rows — correct for UPDATE ... RETURNING.
    const claimedTask = yield* db.transaction((tx) => {
      const rows = tx.query(
        `UPDATE tasks
         SET
           status             = 'claimed',
           lease_owner_run_id = ?,
           lease_until        = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '+' || ? || ' minutes')),
           fencing_token      = fencing_token + 1,
           attempts           = attempts + 1,
           updated_at         = datetime('now')
         WHERE id = (
           SELECT id FROM tasks
           WHERE status     = 'queued'
             AND scope_id   = ?
             AND capability = ?
           ORDER BY created_at ASC, id ASC
           LIMIT 1
         )
         RETURNING *`,
        [runId, leaseMinutes, scope, capability],
      )

      if (rows.length === 0) return null

      const task = rows[0]!

      tx.run(
        `UPDATE runs SET task_id = ?, updated_at = datetime('now') WHERE id = ?`,
        [task.id, runId],
      )

      tx.run(
        `INSERT INTO events (task_id, actor_run_id, type, payload_json)
         VALUES (?, ?, 'task.claimed', ?)`,
        [
          task.id,
          runId,
          JSON.stringify({
            run_id: runId,
            fencing_token: task.fencing_token,
            lease_until: task.lease_until,
          }),
        ],
      )

      return task
    })

    if (claimedTask === null) {
      yield* Effect.fail(
        new PithosError({ code: "NO_CLAIMABLE_WORK", message: "no claimable work found" }),
      )
      return
    }

    yield* output.print(JSON.stringify({ ok: true, task: claimedTask }))
  })

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const CLAIM_HELP = `pithos claim - Atomically claim one queued task for a run

Usage:
  pithos claim --run <run-id> --scope <scope-id> --capability <cap> [options]

Options:
  --run <run-id>         Run ID claiming the task [required]
  --scope <scope-id>     Scope to search within [required]
  --capability <cap>     Task capability to match [required]
  --lease-minutes <n>    Lease duration in minutes (default: 10)
  --help, -h             Show this help

Output (JSON, success):
  { "ok": true, "task": { "id": "task_...", "scope_id": "...", "capability": "...", "fencing_token": 1, "lease_until": "...", ... } }

Output (JSON, no work):
  { "ok": false, "error": "no_claimable_work" }

Notes:
  - Claims the oldest queued task matching the scope and capability (FIFO).
  - The fencing_token must be passed to complete/fail/heartbeat commands.
  - A task can only be held by one run; concurrent claims are safe.

Examples:
  pithos claim --run run_abc --scope global --capability triage
  pithos claim --run run_abc --scope repo:work/perkbox/protobuf --capability watch --lease-minutes 20

Exit codes: 0 success | 2 validation error | 3 not found (run) | 5 no claimable work
`
