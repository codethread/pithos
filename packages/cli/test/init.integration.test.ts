/**
 * Integration tests for `pithos init` — real SQLite + CLI subprocess.
 * Unit coverage lives in src/commands/init.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import Database from "better-sqlite3"

import { initCommand } from "../src/commands/init.ts"
import { makeDbServiceLive } from "../src/layers/db.ts"
import { makeOutputServiceSilent } from "../src/layers/output.ts"
import { runCliOk } from "./_helpers/exec.ts"

const silentOutput = makeOutputServiceSilent()

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-init-"))
}

function runWith<A, E, LE, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, LE, never>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, layer))
}

function runWithExit<A, E, LE, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, LE, never>,
): Promise<Exit.Exit<A, E | LE>> {
  return Effect.runPromiseExit(Effect.provide(effect, layer))
}

function downgradeToLegacySchemaV1(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    DROP TABLE task_dependencies;
    DROP TABLE task_supersessions;
    DELETE FROM schema_migrations WHERE version = 2;
  `)
  db.close()
}

describe("initCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("creates the DB file", async () => {
    await runWith(initCommand, Layer.merge(makeDbServiceLive(dbPath), silentOutput))
    expect(existsSync(dbPath)).toBe(true)
  })

  it("creates all required tables", async () => {
    await runWith(initCommand, Layer.merge(makeDbServiceLive(dbPath), silentOutput))

    const db = new Database(dbPath)
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name)
    db.close()

    expect(tables).toContain("schema_migrations")
    expect(tables).toContain("scopes")
    expect(tables).toContain("runs")
    expect(tables).toContain("tasks")
    expect(tables).toContain("artifacts")
    expect(tables).toContain("events")
    expect(tables).toContain("task_dependencies")
    expect(tables).toContain("task_supersessions")
  })

  it("records migrations 1 and 2 in schema_migrations", async () => {
    await runWith(initCommand, Layer.merge(makeDbServiceLive(dbPath), silentOutput))

    const db = new Database(dbPath)
    const rows = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[]
    db.close()

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.version)).toEqual([1, 2])
  })

  it("inserts the default global scope", async () => {
    await runWith(initCommand, Layer.merge(makeDbServiceLive(dbPath), silentOutput))

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT id, kind, name FROM scopes WHERE id = 'global'")
      .get() as { id: string; kind: string; name: string } | undefined
    db.close()

    expect(row).toBeDefined()
    expect(row?.kind).toBe("global")
    expect(row?.name).toBe("global")
  })

  it("is idempotent — running init twice leaves both migration rows and one global scope", async () => {
    const layer = Layer.merge(makeDbServiceLive(dbPath), silentOutput)
    await runWith(initCommand, layer)
    await runWith(initCommand, layer)

    const db = new Database(dbPath)
    const migRows = db
      .prepare("SELECT version FROM schema_migrations")
      .all() as { version: number }[]
    const scopeRows = db
      .prepare("SELECT id FROM scopes WHERE id = 'global'")
      .all() as { id: string }[]
    db.close()

    expect(migRows).toHaveLength(2)
    expect(scopeRows).toHaveLength(1)
  })

  it("backfills legacy completed parent_id rows into task_dependencies during migration 2", async () => {
    const layer = Layer.merge(makeDbServiceLive(dbPath), silentOutput)
    await runWith(initCommand, layer)
    downgradeToLegacySchemaV1(dbPath)

    const db = new Database(dbPath)
    db.prepare(
      `INSERT INTO tasks (id, scope_id, capability, status, title, body)
       VALUES ('task_parent_done', 'global', 'triage', 'done', 'Parent', '')`,
    ).run()
    db.prepare(
      `INSERT INTO tasks (id, parent_id, scope_id, capability, status, title, body)
       VALUES ('task_child_done', 'task_parent_done', 'global', 'triage', 'done', 'Child', '')`,
    ).run()
    db.close()

    await runWith(initCommand, layer)

    const checkDb = new Database(dbPath)
    const dependencyRows = checkDb
      .prepare(
        `SELECT task_id, depends_on_task_id
         FROM task_dependencies
         ORDER BY task_id ASC, depends_on_task_id ASC`,
      )
      .all() as { task_id: string; depends_on_task_id: string }[]
    const migrationRows = checkDb
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[]
    checkDb.close()

    expect(dependencyRows).toEqual([
      { task_id: "task_child_done", depends_on_task_id: "task_parent_done" },
    ])
    expect(migrationRows.map((row) => row.version)).toEqual([1, 2])
  })

  it("fails migration 2 loudly when unfinished tasks still use legacy parent_id", async () => {
    const layer = Layer.merge(makeDbServiceLive(dbPath), silentOutput)
    await runWith(initCommand, layer)
    downgradeToLegacySchemaV1(dbPath)

    const db = new Database(dbPath)
    db.prepare(
      `INSERT INTO tasks (id, scope_id, capability, status, title, body)
       VALUES ('task_parent_ready', 'global', 'triage', 'done', 'Parent', '')`,
    ).run()
    db.prepare(
      `INSERT INTO tasks (id, parent_id, scope_id, capability, status, title, body)
       VALUES ('task_child_blocked', 'task_parent_ready', 'global', 'triage', 'queued', 'Child', '')`,
    ).run()
    db.close()

    const exit = await runWithExit(initCommand, layer)
    expect(Exit.isFailure(exit)).toBe(true)
    const cause = Exit.isFailure(exit) ? String(exit.cause) : ""
    expect(cause).toContain("Migration 2 blocked")
    expect(cause).toContain("task_child_blocked")

    const checkDb = new Database(dbPath)
    const migrationRows = checkDb
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[]
    const tables = (
      checkDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name)
    checkDb.close()

    expect(migrationRows.map((row) => row.version)).toEqual([1])
    expect(tables).not.toContain("task_dependencies")
    expect(tables).not.toContain("task_supersessions")
  })

  it("does not touch ~/.pandora/pithos.sqlite", async () => {
    const realDbPath = join(homedir(), ".pandora", "pithos.sqlite")
    const mtimeBefore: number | null = existsSync(realDbPath)
      ? statSync(realDbPath).mtimeMs
      : null

    await runWith(initCommand, Layer.merge(makeDbServiceLive(dbPath), silentOutput))

    const mtimeAfter: number | null = existsSync(realDbPath)
      ? statSync(realDbPath).mtimeMs
      : null

    expect(mtimeAfter).toBe(mtimeBefore)
  })
})

describe("pithos init (CLI process — real SQLite)", () => {
  let tempDir: string
  let dbPath: string

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("PITHOS_DB=<temp> pithos init exits 0 and outputs valid JSON", async () => {
    const binPath = join(import.meta.dirname, "../bin/pithos")
    const stdout = await runCliOk(binPath, ["init"], { ...process.env, PITHOS_DB: dbPath })
    const parsed: unknown = JSON.parse(stdout)
    expect(parsed).toMatchObject({ ok: true, initialized: true })
  })

  it("PITHOS_DB=<temp> pithos init twice exits 0 both times (idempotent)", async () => {
    const binPath = join(import.meta.dirname, "../bin/pithos")
    const env = { ...process.env, PITHOS_DB: dbPath }

    const out1 = await runCliOk(binPath, ["init"], env)
    const out2 = await runCliOk(binPath, ["init"], env)

    expect(JSON.parse(out1)).toMatchObject({ ok: true })
    expect(JSON.parse(out2)).toMatchObject({ ok: true })
  })

  it("creates DB in a nested directory that does not yet exist", async () => {
    const nestedDbPath = join(tempDir, "nested", "sub", "pithos.sqlite")
    const binPath = join(import.meta.dirname, "../bin/pithos")
    await runCliOk(binPath, ["init"], { ...process.env, PITHOS_DB: nestedDbPath })
    expect(existsSync(nestedDbPath)).toBe(true)
  })
})
