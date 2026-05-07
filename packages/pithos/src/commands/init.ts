import { Effect } from "effect"
import { resetSchema, runMigrations } from "../db/migrate.ts"
import type { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"

export interface InitOptions {
  readonly fresh?: boolean | undefined
}

export const initCommand = (
  opts: InitOptions = {},
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    const beforeRows = yield* db.query(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name = 'schema_migrations'`,
    )
    const alreadyInitialized = beforeRows.length > 0 && !opts.fresh

    if (opts.fresh) {
      yield* resetSchema
    }

    yield* runMigrations
    yield* db.run(
      `INSERT OR IGNORE INTO scopes (id, kind, name, canonical_path, metadata_json)
       VALUES ('global', 'global', 'global', NULL, '{}')`,
    )

    yield* Effect.logDebug("database initialized").pipe(
      Effect.annotateLogs({ fresh: String(opts.fresh ?? false) }),
    )
    yield* output.print(
      JSON.stringify({ ok: true, initialized: opts.fresh === true || !alreadyInitialized }),
    )
  }).pipe(Effect.withLogSpan("pithos.init"), withCommandObservability("init"))
