import { Effect } from "effect"

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const INIT_HELP = `pithos init - Create DB, run migrations, ensure default global scope

Usage:
  pithos init

Options:
  --help, -h   Show this help

Output (JSON):
  { "ok": true, "initialized": true }

Notes:
  - Creates the SQLite database if it does not exist.
  - Applies all pending migrations.
  - Ensures the built-in global scope ('global') exists.
  - Idempotent: safe to run multiple times.
  - DB path is controlled by PITHOS_DB (default: ~/.pandora/pithos.sqlite).

Examples:
  pithos init
  PITHOS_DB=/tmp/test.sqlite pithos init

Exit codes: 0 success | 1 general error
`
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"
import type { PithosError } from "../errors/errors.ts"
import { runMigrations } from "../db/migrate.ts"
import { withCommandObservability } from "../layers/metrics.ts"

/**
 * `pithos init`
 *
 * Creates (or re-uses) the SQLite database, applies all pending migrations,
 * and ensures the default `global` scope exists. Idempotent.
 */
export const initCommand: Effect.Effect<void, PithosError, DbService | OutputService> =
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    // Apply pending migrations (creates all tables on first run).
    yield* runMigrations

    // Ensure the built-in global scope exists.
    yield* db.run(
      `INSERT OR IGNORE INTO scopes (id, kind, name) VALUES ('global', 'global', 'global')`,
    )

    yield* Effect.logDebug("database initialized")
    yield* output.print(JSON.stringify({ ok: true, initialized: true }))
  }).pipe(
    Effect.withLogSpan("pithos.init"),
    withCommandObservability("init"),
  )
