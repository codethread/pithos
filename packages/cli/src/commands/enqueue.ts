import { Effect } from "effect"
import { DbService } from "../services/db.ts"
import { IdService } from "../services/ids.ts"
import { FsService } from "../services/fs.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  readonly scope: string | undefined
  readonly capability: string | undefined
  readonly title: string | undefined
  readonly body?: string | undefined
  readonly bodyFile?: string | undefined
  readonly parentId?: string | undefined
  /** Run ID recorded as the task creator. */
  readonly run?: string | undefined
}

// ---------------------------------------------------------------------------
// pithos enqueue
// ---------------------------------------------------------------------------

/**
 * `pithos enqueue --scope <id> --capability <cap> --title <title> [options]`
 *
 * Creates a queued task and appends a `task.created` event atomically.
 * The scope must already exist; exits with code 3 if not.
 */
export const enqueueCommand = (
  opts: EnqueueOptions,
): Effect.Effect<void, PithosError, DbService | IdService | FsService | OutputService> =>
  Effect.gen(function* () {
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
    if (!opts.title) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--title is required" }),
      )
      return
    }

    const scope = opts.scope
    const capability = opts.capability
    const title = opts.title

    const db = yield* DbService
    const ids = yield* IdService
    const fs = yield* FsService
    const output = yield* OutputService

    // Read body from file if provided, else fall back to inline body or empty string.
    // Reject supplying both --body and --body-file; the caller must choose one.
    if (opts.body !== undefined && opts.bodyFile !== undefined) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "--body and --body-file are mutually exclusive; supply one or neither",
        }),
      )
      return
    }
    let body = opts.body ?? ""
    if (opts.bodyFile) {
      body = yield* fs.readFile(opts.bodyFile)
    }

    // Validate that the scope exists before inserting.
    const scopeRows = yield* db.query(`SELECT id FROM scopes WHERE id = ?`, [scope])
    if (scopeRows.length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Scope not found: ${scope}` }),
      )
      return
    }

    // Validate optional relational fields to surface clean NOT_FOUND errors
    // rather than opaque FK constraint failures from SQLite.
    if (opts.run) {
      const runRows = yield* db.query(`SELECT id FROM runs WHERE id = ?`, [opts.run])
      if (runRows.length === 0) {
        yield* Effect.fail(
          new PithosError({ code: "NOT_FOUND", message: `Run not found: ${opts.run}` }),
        )
        return
      }
    }

    if (opts.parentId) {
      const parentRows = yield* db.query(`SELECT id FROM tasks WHERE id = ?`, [opts.parentId])
      if (parentRows.length === 0) {
        yield* Effect.fail(
          new PithosError({ code: "NOT_FOUND", message: `Parent task not found: ${opts.parentId}` }),
        )
        return
      }
    }

    const id = yield* ids.generate("task")

    yield* db.withTransaction(
      Effect.gen(function* () {
        yield* db.run(
          `INSERT INTO tasks
             (id, scope_id, capability, status, title, body, parent_id, created_by_run_id)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
          [id, scope, capability, title, body, opts.parentId ?? null, opts.run ?? null],
        )
        yield* db.run(
          `INSERT INTO events (task_id, actor_run_id, type, payload_json)
           VALUES (?, ?, 'task.created', ?)`,
          [id, opts.run ?? null, JSON.stringify({ scope_id: scope, capability, title })],
        )
      }),
    )

    const rows = yield* db.query(`SELECT * FROM tasks WHERE id = ?`, [id])

    yield* output.print(JSON.stringify({ ok: true, task: rows[0] }))
  }).pipe(
    Effect.withLogSpan("pithos.enqueue"),
    withCommandObservability("enqueue"),
  )

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const ENQUEUE_HELP = `pithos enqueue - Create a queued task

Usage:
  pithos enqueue --scope <scope-id> --capability <cap> --title <title> [options]

Options:
  --scope <scope-id>     Scope ID for this task [required]
  --capability <cap>     Task capability, e.g. watch, triage [required]
  --title <title>        Human-readable task title [required]
  --body-file <path>     File path for task body/description (mutually exclusive with --body)
  --body <text>          Inline task body (mutually exclusive with --body-file)
  --run <run-id>         Run ID to record as the task creator
  --parent-id <task-id>  Parent task ID for subtasks
  --help, -h             Show this help

Output (JSON):
  { "ok": true, "task": { "id": "task_...", "scope_id": "...", "status": "queued", ... } }

Examples:
  pithos enqueue --scope global --capability triage --title "Review PR #42"
  pithos enqueue --scope repo:work/perkbox-services/protobuf --capability watch --title "Watch worker" --body-file task.md

Exit codes: 0 success | 2 validation error | 3 not found (scope)
`
