import { Effect, Schema } from "effect"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 1000

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TailOptions {
  readonly limit?: number | undefined
}

// ---------------------------------------------------------------------------
// pithos tail
// ---------------------------------------------------------------------------

/**
 * `pithos tail [--limit <n>]`
 *
 * Returns the most recent events ordered oldest-first (ascending by id).
 * Default limit is 20; maximum is 1000.
 *
 * Output JSON:
 *   { "ok": true, "count": N, "events": [...] }
 *
 * Each event includes id, created_at, type, payload_json, task_id, run_id,
 * and actor_run_id (the task/run references).
 */
export const tailCommand = (
  opts: TailOptions = {},
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const rawLimit = opts.limit ?? DEFAULT_LIMIT

    // Validate: must be a non-zero positive integer
    const limitVal = yield* Schema.decodeUnknown(Schema.Int)(rawLimit).pipe(
      Effect.mapError(
        () =>
          new PithosError({
            code: "VALIDATION_ERROR",
            message: `--limit must be a positive integer, got: ${String(rawLimit)}`,
          }),
      ),
    )

    if (limitVal <= 0) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `--limit must be a positive integer, got: ${limitVal}`,
        }),
      )
      return
    }

    const limit = Math.min(limitVal, MAX_LIMIT)

    const db = yield* DbService
    const output = yield* OutputService

    // Fetch the N most recent events, then return them oldest-first for stable
    // chronological reading. The subquery selects DESC (newest first, for the
    // LIMIT cut), then the outer query re-orders ASC.
    const rows = yield* db.query(
      `SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
      [limit],
    )

    yield* Effect.logDebug("tail complete").pipe(
      Effect.annotateLogs({ limit: String(limit), count: String(rows.length) }),
    )

    yield* output.print(JSON.stringify({ ok: true, count: rows.length, events: rows }))
  }).pipe(
    Effect.withLogSpan("pithos.tail"),
    withCommandObservability("tail"),
  )

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const TAIL_HELP = `pithos tail - Show recent events

Usage:
  pithos tail [options]

Options:
  --limit <n>    Number of recent events to show (default: 20, max: 1000)
  --help, -h     Show this help

Output (JSON):
  {
    "ok": true,
    "count": 3,
    "events": [
      {
        "id": 1,
        "created_at": "2026-05-01T12:00:00Z",
        "actor_run_id": null,
        "task_id": "task_...",
        "run_id": null,
        "type": "task.created",
        "payload_json": "{}"
      },
      ...
    ]
  }

Events are ordered oldest-first (ascending by id).
task_id, run_id, and actor_run_id are null when not applicable.

Examples:
  pithos tail
  pithos tail --limit 50
  pithos tail --limit 100

Exit codes: 0 success | 2 validation error
`
