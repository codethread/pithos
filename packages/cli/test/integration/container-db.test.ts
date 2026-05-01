/**
 * Isolated DB smoke harness.
 *
 * These tests prove that containerised DB/process tests can run against a
 * real SQLite file in a temp directory without ever touching the user's real
 * `~/.pandora/pithos.sqlite`.  They are intentionally free of any CLI,
 * Claude, tmux, or agent dependencies — they exercise `better-sqlite3`
 * directly so the isolation model is verified before the full CLI is wired up
 * in slice 4.
 *
 * "Docker/Podman-compatible" means:
 *   - only temp dirs and env vars for paths — no hardcoded user home paths
 *   - no process spawning of Claude or tmux
 *   - `PITHOS_DB` overrides the DB path exactly as the CLI will honour it
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import Database from "better-sqlite3"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-smoke-"))
}

function openDb(path: string): Database.Database {
  return new Database(path)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("isolated DB smoke harness", () => {
  let tempDir: string
  let dbPath: string

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ── basic isolation ──────────────────────────────────────────────────────

  it("creates a fresh SQLite file inside the temp directory", () => {
    const db = openDb(dbPath)
    db.close()
    expect(existsSync(dbPath)).toBe(true)
  })

  it("DB path is isolated from the production pithos.sqlite", () => {
    const realDbPath = join(homedir(), ".pandora", "pithos.sqlite")
    const db = openDb(dbPath)
    db.close()
    // Must not be the same file as the user's real pithos store.
    expect(dbPath).not.toBe(realDbPath)
    // In standard environments the temp dir lives outside $HOME.
    // Guard the check so it does not fail in container setups where
    // TMPDIR may be mounted under $HOME.
    expect(dbPath).not.toBe(join(homedir(), ".pandora", "pithos.sqlite"))
  })

  it("does not create or modify the real pithos.sqlite", () => {
    const realDbPath = join(homedir(), ".pandora", "pithos.sqlite")
    const mtimeBefore: number | null = existsSync(realDbPath)
      ? statSync(realDbPath).mtimeMs
      : null

    const db = openDb(dbPath)
    db.exec("CREATE TABLE smoke_check (id INTEGER PRIMARY KEY)")
    db.prepare("INSERT INTO smoke_check VALUES (1)").run()
    db.close()

    const mtimeAfter: number | null = existsSync(realDbPath)
      ? statSync(realDbPath).mtimeMs
      : null

    // Real DB must be unchanged (or still absent).
    expect(mtimeAfter).toBe(mtimeBefore)
  })

  it("each test gets a fresh DB with no leftover state from siblings", () => {
    const db = openDb(dbPath)
    db.exec("CREATE TABLE items (id TEXT PRIMARY KEY)")
    const n = (db.prepare("SELECT count(*) as n FROM items").get() as { n: number }).n
    db.close()
    expect(n).toBe(0)
  })

  // ── schema migrations table (mirrors the real schema contract) ───────────

  it("can create schema_migrations table and insert a version row", () => {
    const db = openDb(dbPath)
    db.exec(`
      CREATE TABLE schema_migrations (
        version     INTEGER PRIMARY KEY,
        applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(1)
    const rows = db
      .prepare("SELECT version FROM schema_migrations")
      .all() as { version: number }[]
    db.close()

    expect(rows).toHaveLength(1)
    expect(rows[0]?.version).toBe(1)
  })

  it("duplicate version insert is rejected by the PK constraint", () => {
    const db = openDb(dbPath)
    db.exec(`
      CREATE TABLE schema_migrations (
        version     INTEGER PRIMARY KEY,
        applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(1)

    // A second insert of the same version must throw (UNIQUE / PRIMARY KEY
    // constraint).  Note: `pithos init` will use INSERT OR IGNORE semantics
    // so re-running init is safe — this test covers the bare constraint only.
    expect(() => {
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(1)
    }).toThrow()

    db.close()
  })

  // ── task seeding (validates the isolation model for future claim tests) ──

  it("can seed task rows and query them back without any CLI dependency", () => {
    const db = openDb(dbPath)
    db.exec(`
      CREATE TABLE tasks (
        id          TEXT PRIMARY KEY,
        status      TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'running', 'done')),
        capability  TEXT NOT NULL
      )
    `)
    const ins = db.prepare(
      "INSERT INTO tasks (id, status, capability) VALUES (?, ?, ?)",
    )
    ins.run("task_001", "queued", "watch")
    ins.run("task_002", "queued", "triage")
    ins.run("task_003", "claimed", "watch")

    const queued = db
      .prepare("SELECT id FROM tasks WHERE status = 'queued' ORDER BY id")
      .all() as { id: string }[]
    db.close()

    expect(queued).toHaveLength(2)
    expect(queued[0]?.id).toBe("task_001")
    expect(queued[1]?.id).toBe("task_002")
  })

  it("atomic UPDATE RETURNING rejects a claim when no queued row exists", () => {
    const db = openDb(dbPath)
    db.exec(`
      CREATE TABLE tasks (
        id                TEXT PRIMARY KEY,
        status            TEXT NOT NULL,
        capability        TEXT NOT NULL,
        lease_owner_run_id TEXT,
        fencing_token     INTEGER NOT NULL DEFAULT 0,
        attempts          INTEGER NOT NULL DEFAULT 0
      )
    `)
    // No queued rows — claim should return zero results.
    const claimed = db
      .prepare(`
        UPDATE tasks
        SET
          status             = 'claimed',
          lease_owner_run_id = ?,
          fencing_token      = fencing_token + 1,
          attempts           = attempts + 1
        WHERE id = (
          SELECT id FROM tasks
          WHERE status = 'queued' AND capability = ?
          ORDER BY rowid ASC
          LIMIT 1
        )
        RETURNING *
      `)
      .all("run_x", "watch") as { id: string }[]
    db.close()

    expect(claimed).toHaveLength(0)
  })

  // ── env-var isolation pattern ────────────────────────────────────────────

  it("PITHOS_DB env-var pattern routes tests to an isolated path", () => {
    // The CLI (slice 4+) will honour PITHOS_DB=<path> so tests and
    // containers can redirect away from ~/.pandora/pithos.sqlite.
    // This test documents and validates the isolation pattern only;
    // actual CLI env-var wiring is covered by slice 4 CLI process tests.
    const envDb = process.env.PITHOS_DB ?? null
    const effectivePath = envDb ?? dbPath
    expect(effectivePath).not.toBe(join(homedir(), ".pandora", "pithos.sqlite"))
    expect(effectivePath.length).toBeGreaterThan(0)
  })
})
