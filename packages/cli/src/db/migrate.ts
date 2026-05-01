import { Effect } from "effect"
import { DbService } from "../services/db.ts"
import type { PithosError } from "../errors/errors.ts"

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

interface Migration {
  readonly version: number
  readonly name: string
  /** Individual SQL statements (each run separately). */
  readonly statements: readonly string[]
}

/**
 * Migration 1 – full initial schema.
 * All tables use IF NOT EXISTS for safety; the migration tracker prevents
 * double-application under normal operation.
 */
const MIGRATION_1: Migration = {
  version: 1,
  name: "initial_schema",
  statements: [
    `CREATE TABLE IF NOT EXISTS scopes (
      id             TEXT PRIMARY KEY,
      kind           TEXT NOT NULL CHECK (kind IN ('global', 'repo', 'worktree')),
      name           TEXT NOT NULL,
      canonical_path TEXT,
      metadata_json  TEXT NOT NULL DEFAULT '{}',
      created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS runs (
      id                TEXT PRIMARY KEY,
      agent_kind        TEXT NOT NULL,
      scope_id          TEXT REFERENCES scopes(id),
      task_id           TEXT,
      parent_run_id     TEXT REFERENCES runs(id),
      harness           TEXT NOT NULL DEFAULT 'claude-code',
      session_id        TEXT,
      tmux_target       TEXT,
      cwd               TEXT,
      status            TEXT NOT NULL CHECK (status IN ('starting','running','idle','stale','ended','failed','cancelled')),
      last_heartbeat_at TEXT,
      last_hook         TEXT,
      last_summary      TEXT,
      metadata_json     TEXT NOT NULL DEFAULT '{}',
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at          TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id                 TEXT PRIMARY KEY,
      parent_id          TEXT REFERENCES tasks(id),
      scope_id           TEXT NOT NULL REFERENCES scopes(id),
      capability         TEXT NOT NULL,
      status             TEXT NOT NULL CHECK (status IN ('queued','claimed','running','done','failed','dead_letter','cancelled')),
      title              TEXT NOT NULL,
      body               TEXT NOT NULL DEFAULT '',
      payload_json       TEXT NOT NULL DEFAULT '{}',
      lease_owner_run_id TEXT REFERENCES runs(id),
      lease_until        TEXT,
      fencing_token      INTEGER NOT NULL DEFAULT 0,
      attempts           INTEGER NOT NULL DEFAULT 0,
      max_attempts       INTEGER NOT NULL DEFAULT 3,
      result_json        TEXT NOT NULL DEFAULT '{}',
      created_by_run_id  TEXT REFERENCES runs(id),
      created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at       TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS artifacts (
      id            TEXT PRIMARY KEY,
      task_id       TEXT REFERENCES tasks(id),
      run_id        TEXT REFERENCES runs(id),
      kind          TEXT NOT NULL,
      title         TEXT NOT NULL,
      body          TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor_run_id TEXT REFERENCES runs(id),
      task_id      TEXT REFERENCES tasks(id),
      run_id       TEXT REFERENCES runs(id),
      type         TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_claimable ON tasks(scope_id, capability, status, lease_until)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_parent    ON tasks(parent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_runs_status     ON runs(status, last_heartbeat_at)`,
    `CREATE INDEX IF NOT EXISTS idx_events_task     ON events(task_id, id)`,
    `CREATE INDEX IF NOT EXISTS idx_events_created  ON events(id)`,
  ],
}

const MIGRATIONS: readonly Migration[] = [MIGRATION_1]

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Applies all pending migrations to the database.
 *
 * Idempotent: already-applied migrations (tracked in schema_migrations) are
 * skipped. The schema_migrations table itself is created via a bootstrap step
 * that is not itself tracked.
 */
export const runMigrations: Effect.Effect<void, PithosError, DbService> = Effect.gen(
  function* () {
    const db = yield* DbService

    // Bootstrap: ensure schema_migrations exists.
    // Uses CREATE TABLE IF NOT EXISTS so this is safe to run every time.
    yield* db.run(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    )

    // Determine which versions have already been applied.
    const appliedRows = yield* db.query("SELECT version FROM schema_migrations")
    const appliedVersions = new Set(appliedRows.map((r) => r.version as number))

    // Apply each unapplied migration inside a single atomic transaction.
    for (const migration of MIGRATIONS) {
      if (!appliedVersions.has(migration.version)) {
        yield* db.transaction((tx) => {
          for (const sql of migration.statements) {
            tx.run(sql)
          }
          tx.run("INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)", [
            migration.version,
          ])
        })
      }
    }
  },
)
