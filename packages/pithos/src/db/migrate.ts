import { Effect, Schema } from "effect"
import type { PithosError } from "../errors/errors.ts"
import { PithosError as PE } from "../errors/errors.ts"
import { DbService } from "../services/db.ts"
import { MigrationRow } from "./rows.ts"

class SqliteObjectRow extends Schema.Class<SqliteObjectRow>("SqliteObjectRow")({
  name: Schema.String,
}) {}

class TableInfoRow extends Schema.Class<TableInfoRow>("TableInfoRow")({
  name: Schema.String,
}) {}

const decodeSqliteObjectRow = (row: unknown): Effect.Effect<SqliteObjectRow, PithosError> =>
  Schema.decodeUnknown(SqliteObjectRow)(row).pipe(
    Effect.mapError(
      () =>
        new PE({
          code: "INTERNAL_ERROR",
          message: "sqlite_master row shape violation",
        }),
    ),
  )

const decodeTableInfoRow = (row: unknown): Effect.Effect<TableInfoRow, PithosError> =>
  Schema.decodeUnknown(TableInfoRow)(row).pipe(
    Effect.mapError(
      () =>
        new PE({
          code: "INTERNAL_ERROR",
          message: "PRAGMA table_info row shape violation",
        }),
    ),
  )

const SCHEMA_MIGRATIONS_STATEMENT = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`

const INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_tasks_claimable ON tasks(scope_id, capability, status, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocker ON task_dependencies(depends_on_task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_supersessions_new ON task_supersessions(new_task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, last_heartbeat_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_created ON events(id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id) WHERE task_id IS NOT NULL`,
] as const

const SEED_STATEMENTS = [
  `INSERT OR IGNORE INTO scopes (id, kind, name, canonical_path, metadata_json)
   VALUES ('global', 'global', 'global', NULL, '{}')`,
  `INSERT OR IGNORE INTO agent_kinds (agent_kind)
   VALUES ('pdx'), ('pandora'), ('toil'), ('greed'), ('war')`,
  `INSERT OR IGNORE INTO capabilities (capability)
   VALUES ('triage'), ('design'), ('execute'), ('escalate')`,
  `INSERT OR IGNORE INTO agent_claims (agent_kind, capability)
   VALUES ('pandora', 'escalate'), ('toil', 'triage'), ('greed', 'design'), ('war', 'execute')`,
  `INSERT OR IGNORE INTO agent_enqueues (agent_kind, capability)
   VALUES
     ('pdx', 'escalate'),
     ('pandora', 'triage'),
     ('pandora', 'design'),
     ('pandora', 'escalate'),
     ('toil', 'triage'),
     ('toil', 'design'),
     ('toil', 'execute'),
     ('toil', 'escalate'),
     ('greed', 'triage'),
     ('greed', 'design'),
     ('greed', 'escalate'),
     ('war', 'escalate')`,
] as const

const MANAGED_TABLE_COLUMNS = {
  schema_migrations: ["version", "applied_at"],
  scopes: [
    "id",
    "kind",
    "name",
    "canonical_path",
    "metadata_json",
    "created_at",
    "updated_at",
  ],
  agent_kinds: ["agent_kind", "created_at"],
  capabilities: ["capability", "created_at"],
  runs: [
    "id",
    "agent_kind",
    "mode",
    "scope_id",
    "task_id",
    "harness",
    "session_id",
    "tmux_target",
    "cwd",
    "status",
    "last_heartbeat_at",
    "metadata_json",
    "created_at",
    "updated_at",
    "ended_at",
  ],
  tasks: [
    "id",
    "scope_id",
    "capability",
    "status",
    "title",
    "body",
    "payload_json",
    "fencing_token",
    "attempts",
    "max_attempts",
    "result_json",
    "created_by_run_id",
    "created_at",
    "updated_at",
    "completed_at",
  ],
  task_dependencies: ["task_id", "depends_on_task_id", "created_at"],
  task_supersessions: [
    "old_task_id",
    "new_task_id",
    "created_by_run_id",
    "reason",
    "created_at",
  ],
  agent_claims: ["agent_kind", "capability", "created_at"],
  agent_enqueues: ["agent_kind", "capability", "created_at"],
  artifacts: ["id", "task_id", "run_id", "kind", "title", "body", "metadata_json", "created_at"],
  events: ["id", "created_at", "actor_run_id", "task_id", "run_id", "type", "payload_json"],
} as const

const MANAGED_TABLE_NAMES = Object.keys(MANAGED_TABLE_COLUMNS) as readonly (
  keyof typeof MANAGED_TABLE_COLUMNS
)[]

interface Migration {
  readonly version: number
  readonly name: string
  readonly statements: readonly string[]
}

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
    `CREATE TABLE IF NOT EXISTS agent_kinds (
      agent_kind TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS capabilities (
      capability TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS runs (
      id                TEXT PRIMARY KEY,
      agent_kind        TEXT NOT NULL REFERENCES agent_kinds(agent_kind),
      mode              TEXT NOT NULL CHECK (mode IN ('afk', 'hitl')),
      scope_id          TEXT NOT NULL REFERENCES scopes(id),
      task_id           TEXT,
      harness           TEXT NOT NULL DEFAULT 'claude-code',
      session_id        TEXT NOT NULL,
      tmux_target       TEXT,
      cwd               TEXT NOT NULL,
      status            TEXT NOT NULL CHECK (status IN ('starting', 'running', 'idle', 'stale', 'ended', 'failed', 'cancelled', 'timed_out')),
      last_heartbeat_at TEXT,
      metadata_json     TEXT NOT NULL DEFAULT '{}',
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at          TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id                TEXT PRIMARY KEY,
      scope_id          TEXT NOT NULL REFERENCES scopes(id),
      capability        TEXT NOT NULL REFERENCES capabilities(capability),
      status            TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'running', 'done', 'failed', 'dead_letter', 'cancelled')),
      title             TEXT NOT NULL,
      body              TEXT NOT NULL,
      payload_json      TEXT NOT NULL DEFAULT '{}',
      fencing_token     INTEGER NOT NULL DEFAULT 0,
      attempts          INTEGER NOT NULL DEFAULT 0,
      max_attempts      INTEGER NOT NULL DEFAULT 3,
      result_json       TEXT NOT NULL DEFAULT '{}',
      created_by_run_id TEXT REFERENCES runs(id),
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at      TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id            TEXT NOT NULL REFERENCES tasks(id),
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
      created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (task_id, depends_on_task_id),
      CHECK (task_id <> depends_on_task_id)
    )`,
    `CREATE TABLE IF NOT EXISTS task_supersessions (
      old_task_id       TEXT PRIMARY KEY REFERENCES tasks(id),
      new_task_id       TEXT NOT NULL UNIQUE REFERENCES tasks(id),
      created_by_run_id TEXT REFERENCES runs(id),
      reason            TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (old_task_id <> new_task_id)
    )`,
    `CREATE TABLE IF NOT EXISTS agent_claims (
      agent_kind TEXT NOT NULL REFERENCES agent_kinds(agent_kind),
      capability TEXT NOT NULL REFERENCES capabilities(capability),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (agent_kind, capability)
    )`,
    `CREATE TABLE IF NOT EXISTS agent_enqueues (
      agent_kind TEXT NOT NULL REFERENCES agent_kinds(agent_kind),
      capability TEXT NOT NULL REFERENCES capabilities(capability),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (agent_kind, capability)
    )`,
    `CREATE TABLE IF NOT EXISTS artifacts (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL REFERENCES tasks(id),
      run_id        TEXT NOT NULL REFERENCES runs(id),
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
  ],
}

const MIGRATIONS: readonly Migration[] = [MIGRATION_1]

const RESET_STATEMENTS = [
  `DROP TABLE IF EXISTS artifacts`,
  `DROP TABLE IF EXISTS events`,
  `DROP TABLE IF EXISTS task_dependencies`,
  `DROP TABLE IF EXISTS task_supersessions`,
  `DROP TABLE IF EXISTS tasks`,
  `DROP TABLE IF EXISTS agent_claims`,
  `DROP TABLE IF EXISTS agent_enqueues`,
  `DROP TABLE IF EXISTS runs`,
  `DROP TABLE IF EXISTS capabilities`,
  `DROP TABLE IF EXISTS agent_kinds`,
  `DROP TABLE IF EXISTS scopes`,
  `DROP TABLE IF EXISTS schema_migrations`,
] as const

interface DbConnection {
  readonly query: (
    sql: string,
    params?: readonly unknown[],
  ) => Effect.Effect<readonly unknown[], PithosError>
  readonly run: (
    sql: string,
    params?: readonly unknown[],
  ) => Effect.Effect<void, PithosError>
  readonly withTransaction: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | PithosError>
}

const decodeAppliedVersions = (
  rows: readonly unknown[],
): Effect.Effect<ReadonlySet<number>, PithosError> =>
  Effect.all(
    rows.map((row) =>
      Schema.decodeUnknown(MigrationRow)(row).pipe(
        Effect.map((decoded) => decoded.version),
        Effect.mapError(
          () =>
            new PE({
              code: "INTERNAL_ERROR",
              message: "schema_migrations row shape violation",
            }),
        ),
      ),
    ),
  ).pipe(Effect.map((versions) => new Set(versions)))

const loadUserTableNames = (
  db: DbConnection,
): Effect.Effect<readonly string[], PithosError> =>
  db
    .query(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`,
    )
    .pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeSqliteObjectRow)),
      Effect.map((rows) => rows.map((row) => row.name)),
    )

const loadTableColumns = (
  db: DbConnection,
  tableName: keyof typeof MANAGED_TABLE_COLUMNS,
): Effect.Effect<readonly string[], PithosError> =>
  db.query(`PRAGMA table_info(${tableName})`).pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, decodeTableInfoRow)),
    Effect.map((rows) => rows.map((row) => row.name)),
  )

const assertSchemaCompatible = (db: DbConnection): Effect.Effect<void, PithosError> =>
  Effect.gen(function* () {
    const tableNames = yield* loadUserTableNames(db)

    for (const tableName of MANAGED_TABLE_NAMES.filter((name) => tableNames.includes(name))) {
      const actualColumns = yield* loadTableColumns(db, tableName)
      const expectedColumns = [...MANAGED_TABLE_COLUMNS[tableName]]
      const actualKey = actualColumns.join(",")
      const expectedKey = expectedColumns.join(",")

      if (actualKey !== expectedKey) {
        yield* Effect.fail(
          new PE({
            code: "VALIDATION_ERROR",
            message:
              `Existing DB schema is incompatible with pithos-next: table ${tableName} columns ` +
              `[${actualColumns.join(", ")}] do not match expected [${expectedColumns.join(", ")}]. ` +
              `Use 'pithos-next init --fresh' or point PITHOS_DB at a clean database.`,
          }),
        )
      }
    }

    if (!tableNames.includes("schema_migrations")) {
      return
    }

    const appliedVersions = yield* db.query(`SELECT version FROM schema_migrations`).pipe(
      Effect.flatMap(decodeAppliedVersions),
    )

    if (!appliedVersions.has(1)) {
      return
    }

    const missingTables = MANAGED_TABLE_NAMES.filter((name) => !tableNames.includes(name))
    if (missingTables.length > 0) {
      yield* Effect.fail(
        new PE({
          code: "VALIDATION_ERROR",
          message:
            `Existing DB schema is incomplete for pithos-next: missing tables ${missingTables.join(", ")}. ` +
            `Use 'pithos-next init --fresh' or point PITHOS_DB at a clean database.`,
        }),
      )
    }
  })

const ensureIndexesAndSeeds = (db: DbConnection): Effect.Effect<void, PithosError> =>
  db.withTransaction(
    Effect.gen(function* () {
      for (const statement of INDEX_STATEMENTS) {
        yield* db.run(statement)
      }
      for (const statement of SEED_STATEMENTS) {
        yield* db.run(statement)
      }
    }),
  )

export const resetSchema: Effect.Effect<void, PithosError, DbService> = Effect.gen(function* () {
  const db = yield* DbService

  yield* db.withTransaction(
    Effect.gen(function* () {
      for (const statement of RESET_STATEMENTS) {
        yield* db.run(statement)
      }
    }),
  )
})

export const runMigrations: Effect.Effect<void, PithosError, DbService> = Effect.gen(function* () {
  const db = yield* DbService

  yield* assertSchemaCompatible(db)
  yield* db.run(SCHEMA_MIGRATIONS_STATEMENT)

  const appliedVersions = yield* db.query(`SELECT version FROM schema_migrations`).pipe(
    Effect.flatMap(decodeAppliedVersions),
  )

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue
    }

    yield* db.withTransaction(
      Effect.gen(function* () {
        for (const statement of migration.statements) {
          yield* db.run(statement)
        }
        yield* db.run(`INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)`, [
          migration.version,
        ])
      }),
    )
  }

  yield* ensureIndexesAndSeeds(db)
})
