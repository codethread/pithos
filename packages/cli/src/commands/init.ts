import { Effect } from "effect"
import { DbService } from "../services/db.ts"
import type { PithosError } from "../errors/errors.ts"
import { runMigrations } from "../db/migrate.ts"

/**
 * `pithos init`
 *
 * Creates (or re-uses) the SQLite database, applies all pending migrations,
 * and ensures the default `global` scope exists. Idempotent.
 */
export const initCommand: Effect.Effect<void, PithosError, DbService> = Effect.gen(function* () {
  const db = yield* DbService

  // Apply pending migrations (creates all tables on first run).
  yield* runMigrations

  // Ensure the built-in global scope exists.
  yield* db.run(
    `INSERT OR IGNORE INTO scopes (id, kind, name) VALUES ('global', 'global', 'global')`,
  )

  yield* Effect.sync(() => {
    console.log(JSON.stringify({ ok: true, initialized: true }))
  })
})
