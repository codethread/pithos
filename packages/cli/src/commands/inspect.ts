import { Effect } from "effect"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"

/**
 * `pithos inspect scope <id>`
 *
 * Fetches the scope row and prints it as JSON.
 * Exits with code 3 (NOT_FOUND) if the scope does not exist.
 */
export const inspectScopeCommand = (id: string): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    const rows = yield* db.query(`SELECT * FROM scopes WHERE id = ?`, [id])

    if (rows.length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Scope not found: ${id}` }),
      )
      return
    }

    yield* output.print(JSON.stringify({ ok: true, scope: rows[0] }))
  }).pipe(
    Effect.withLogSpan("pithos.inspect.scope"),
    withCommandObservability("inspect.scope"),
  )

/**
 * `pithos inspect task <id>`
 *
 * Fetches the task row and its associated artifacts, then prints as JSON.
 * Exits with code 3 (NOT_FOUND) if the task does not exist.
 */
export const inspectTaskCommand = (id: string): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    const rows = yield* db.query(`SELECT * FROM tasks WHERE id = ?`, [id])

    if (rows.length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Task not found: ${id}` }),
      )
      return
    }

    const artifacts = yield* db.query(
      `SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC`,
      [id],
    )

    yield* output.print(JSON.stringify({ ok: true, task: rows[0], artifacts }))
  }).pipe(
    Effect.withLogSpan("pithos.inspect.task"),
    withCommandObservability("inspect.task"),
  )

/**
 * `pithos inspect run <id>`
 *
 * Fetches the run row and prints it as JSON.
 * Exits with code 3 (NOT_FOUND) if the run does not exist.
 */
export const inspectRunCommand = (id: string): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    const rows = yield* db.query(`SELECT * FROM runs WHERE id = ?`, [id])

    if (rows.length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Run not found: ${id}` }),
      )
      return
    }

    yield* output.print(JSON.stringify({ ok: true, run: rows[0] }))
  }).pipe(
    Effect.withLogSpan("pithos.inspect.run"),
    withCommandObservability("inspect.run"),
  )

export const INSPECT_HELP = `pithos inspect - Inspect a pithos entity

Usage:
  pithos inspect scope <id>
  pithos inspect run <id>
  pithos inspect task <id>

Subcommands:
  scope <id>    Show a scope by ID
  run <id>      Show a run by ID
  task <id>     Show a task by ID (includes artifacts array)

Output (JSON):
  { "ok": true, "scope": { "id": "...", "kind": "...", ... } }
  { "ok": true, "run": { "id": "...", "agent_kind": "...", ... } }
  { "ok": true, "task": { "id": "...", "status": "queued", ... }, "artifacts": [ ... ] }

Examples:
  pithos inspect scope global
  pithos inspect scope repo:work/perkbox-services/protobuf
  pithos inspect run run_abc123
  pithos inspect task task_abc123

Exit codes: 0 success | 3 not found
`
