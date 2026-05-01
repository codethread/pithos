import { Effect } from "effect"
import { DbService } from "../services/db.ts"
import { PithosError } from "../errors/errors.ts"

/**
 * `pithos inspect scope <id>`
 *
 * Fetches the scope row and prints it as JSON.
 * Exits with code 3 (NOT_FOUND) if the scope does not exist.
 */
export const inspectScopeCommand = (id: string): Effect.Effect<void, PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService

    const rows = yield* db.query(`SELECT * FROM scopes WHERE id = ?`, [id])

    if (rows.length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Scope not found: ${id}` }),
      )
      return
    }

    yield* Effect.sync(() => {
      console.log(JSON.stringify({ ok: true, scope: rows[0] }))
    })
  })

/**
 * `pithos inspect run <id>`
 *
 * Fetches the run row and prints it as JSON.
 * Exits with code 3 (NOT_FOUND) if the run does not exist.
 */
export const inspectRunCommand = (id: string): Effect.Effect<void, PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService

    const rows = yield* db.query(`SELECT * FROM runs WHERE id = ?`, [id])

    if (rows.length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Run not found: ${id}` }),
      )
      return
    }

    yield* Effect.sync(() => {
      console.log(JSON.stringify({ ok: true, run: rows[0] }))
    })
  })

export const INSPECT_HELP = `pithos inspect - Inspect a pithos entity

Usage:
  pithos inspect scope <id>
  pithos inspect run <id>

Subcommands:
  scope <id>    Show a scope by ID
  run <id>      Show a run by ID

Output (JSON):
  { "ok": true, "scope": { "id": "...", "kind": "...", ... } }
  { "ok": true, "run": { "id": "...", "agent_kind": "...", ... } }

Examples:
  pithos inspect scope global
  pithos inspect scope repo:work/perkbox-services/protobuf
  pithos inspect run run_abc123

Exit codes: 0 success | 3 not found
`
