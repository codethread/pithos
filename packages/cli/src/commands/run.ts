import { Effect, Schema } from "effect"
import { DbService } from "../services/db.ts"
import { IdService } from "../services/ids.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RunEndStatusSchema = Schema.Literal("ended", "failed", "cancelled")

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface RunRegisterOptions {
  readonly agentKind: string | undefined
  readonly scopeId?: string | undefined
  readonly cwd?: string | undefined
  readonly sessionId?: string | undefined
  readonly parentRun?: string | undefined
  /** Explicit run ID — returns the existing run if it already exists (idempotent). */
  readonly run?: string | undefined
}

export interface RunEndOptions {
  readonly run: string | undefined
  readonly status: string | undefined
  readonly summary?: string | undefined
}

// ---------------------------------------------------------------------------
// pithos run register
// ---------------------------------------------------------------------------

/**
 * `pithos run register --agent-kind <kind> [options]`
 *
 * Creates a new run with status='starting' and appends a `run.registered`
 * lifecycle event atomically. If `--run <id>` is supplied and the run already
 * exists, returns the existing row without creating a duplicate (idempotent).
 */
export const runRegisterCommand = (
  opts: RunRegisterOptions,
): Effect.Effect<void, PithosError, DbService | IdService | OutputService> =>
  Effect.gen(function* () {
    if (!opts.agentKind) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--agent-kind is required" }),
      )
      return
    }
    const agentKind = opts.agentKind

    const db = yield* DbService
    const ids = yield* IdService
    const output = yield* OutputService

    const id = opts.run ?? (yield* ids.generate("run"))

    // Use INSERT OR IGNORE so concurrent calls with the same explicit --run ID
    // are race-safe: exactly one insertion wins; the loser silently skips.
    // The lifecycle event is only appended for the winning insertion.
    yield* db.transaction((tx) => {
      const result = tx.run(
        `INSERT OR IGNORE INTO runs (id, agent_kind, scope_id, cwd, session_id, parent_run_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'starting')`,
        [
          id,
          agentKind,
          opts.scopeId ?? null,
          opts.cwd ?? null,
          opts.sessionId ?? null,
          opts.parentRun ?? null,
        ],
      )
      if (result.changes > 0) {
        tx.run(
          `INSERT INTO events (run_id, actor_run_id, type, payload_json)
           VALUES (?, ?, 'run.registered', '{}')`,
          [id, id],
        )
      }
    })

    const rows = yield* db.query(`SELECT * FROM runs WHERE id = ?`, [id])

    yield* Effect.logDebug("run registered").pipe(
      Effect.annotateLogs({ runId: id, agentKind }),
    )
    yield* output.print(JSON.stringify({ ok: true, run: rows[0] }))
  }).pipe(
    Effect.withLogSpan("pithos.run.register"),
    withCommandObservability("run.register"),
  )

// ---------------------------------------------------------------------------
// pithos run end
// ---------------------------------------------------------------------------

/**
 * `pithos run end --run <run-id> [--status <status>] [--summary <text>]`
 *
 * Marks the run as ended/failed/cancelled, records `ended_at`, and appends a
 * `run.ended` lifecycle event. Idempotent if the run is already terminal.
 * Exits with code 3 (NOT_FOUND) if the run does not exist.
 */
export const runEndCommand = (
  opts: RunEndOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    if (!opts.run) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }),
      )
      return
    }
    const runId = opts.run

    // Validate --status: if provided it must be a recognised terminal status.
    const rawStatus = opts.status ?? "ended"
    const status = yield* Schema.decodeUnknown(RunEndStatusSchema)(rawStatus).pipe(
      Effect.mapError(
        () =>
          new PithosError({
            code: "VALIDATION_ERROR",
            message: `Invalid --status value: '${rawStatus}'. Valid values: ended, failed, cancelled`,
          }),
      ),
    )

    const db = yield* DbService
    const output = yield* OutputService

    // Atomically check existence, update status, and insert lifecycle event.
    // Returns false when the run ID does not exist so we can emit NOT_FOUND
    // without a racy follow-up SELECT.
    const exists = yield* db.transaction((tx) => {
      const check = tx.query(`SELECT id FROM runs WHERE id = ?`, [runId])
      if (check.length === 0) return false
      const result = tx.run(
        `UPDATE runs
         SET   status       = ?,
               last_summary = ?,
               ended_at     = datetime('now'),
               updated_at   = datetime('now')
         WHERE id = ?
           AND status NOT IN ('ended', 'failed', 'cancelled')`,
        [status, opts.summary ?? null, runId],
      )
      if (result.changes > 0) {
        tx.run(
          `INSERT INTO events (run_id, actor_run_id, type, payload_json)
           VALUES (?, ?, 'run.ended', ?)`,
          [
            runId,
            runId,
            JSON.stringify({ status, summary: opts.summary ?? null }),
          ],
        )
      }
      return true
    })

    if (!exists) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Run not found: ${runId}` }),
      )
      return
    }

    const rows = yield* db.query(`SELECT * FROM runs WHERE id = ?`, [runId])

    yield* Effect.logDebug("run ended").pipe(
      Effect.annotateLogs({ runId, status }),
    )
    yield* output.print(JSON.stringify({ ok: true, run: rows[0] }))
  }).pipe(
    Effect.withLogSpan("pithos.run.end"),
    withCommandObservability("run.end"),
  )

// ---------------------------------------------------------------------------
// Help texts
// ---------------------------------------------------------------------------

export const RUN_REGISTER_HELP = `pithos run register - Register a Claude Code/worker/agent run

Usage:
  pithos run register --agent-kind <kind> [options]

Options:
  --agent-kind <kind>    Agent kind, e.g. envy, toil, worker [required]
  --scope <scope-id>     Scope ID for this run
  --cwd <path>           Working directory for this run
  --session-id <uuid>    Claude Code session ID
  --parent-run <run-id>  Parent run ID (for child/worker runs)
  --run <run-id>         Explicit ID; returns existing run if already registered (idempotent)
  --help, -h             Show this help

Output (JSON):
  { "ok": true, "run": { "id": "run_...", "agent_kind": "...", "status": "starting", ... } }

Examples:
  pithos run register --agent-kind envy --scope repo:work/perkbox-services/protobuf --cwd /home/user/work
  pithos run register --agent-kind worker --parent-run run_abc --session-id abc123

Exit codes: 0 success | 2 validation error
`

export const RUN_END_HELP = `pithos run end - Mark a run as ended/failed/cancelled

Usage:
  pithos run end --run <run-id> [options]

Options:
  --run <run-id>      Run ID to terminate [required]
  --status <status>   Terminal status: ended | failed | cancelled (default: ended)
  --summary <text>    Optional last summary for the run
  --help, -h          Show this help

Output (JSON):
  { "ok": true, "run": { "id": "run_...", "status": "ended", "ended_at": "...", ... } }

Examples:
  pithos run end --run run_abc
  pithos run end --run run_abc --status failed --summary "worker disappeared"

Exit codes: 0 success | 2 validation error | 3 not found
`
