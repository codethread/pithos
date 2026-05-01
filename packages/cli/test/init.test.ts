/**
 * Tests for `pithos init`.
 *
 * Two layers:
 *  1. Unit tests — fake DbService, validate command logic and output.
 *  2. Integration tests — real SQLite in a temp directory, validate actual SQL
 *     and idempotency. No real ~/.pandora/pithos.sqlite is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, type Layer } from "effect"
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import { execFileSync } from "node:child_process"
import Database from "better-sqlite3"

import { initCommand } from "../src/commands/init.ts"
import { runMigrations } from "../src/db/migrate.ts"
import { makeDbServiceTest, makeDbServiceLive } from "../src/layers/db.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-init-"))
}

function runWith<A, E, LE, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, LE, never>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, layer))
}

// ---------------------------------------------------------------------------
// Unit tests — fake DB
// ---------------------------------------------------------------------------

describe("initCommand (unit — fake DB)", () => {
  it("succeeds with a fresh fake DB", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(initCommand, makeDbServiceTest()),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("succeeds a second time (idempotent with fake DB)", async () => {
    const layer = makeDbServiceTest()
    const first = await Effect.runPromiseExit(Effect.provide(initCommand, layer))
    const second = await Effect.runPromiseExit(Effect.provide(initCommand, layer))
    expect(Exit.isSuccess(first)).toBe(true)
    expect(Exit.isSuccess(second)).toBe(true)
  })
})

describe("runMigrations (unit — fake DB)", () => {
  it("applies migration 1 when schema_migrations returns no rows", async () => {
    // Fake DB: query always returns [], run always succeeds.
    // The migration should run without error.
    const exit = await Effect.runPromiseExit(
      Effect.provide(runMigrations, makeDbServiceTest()),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("skips migration 1 when it is already recorded in schema_migrations", async () => {
    // Fake DB seeded so that 'SELECT version FROM schema_migrations' returns [{version:1}].
    const seeded = new Map([["SELECT version FROM schema_migrations", [{ version: 1 }]]])
    const exit = await Effect.runPromiseExit(
      Effect.provide(runMigrations, makeDbServiceTest(seeded)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — real SQLite in temp dir
// ---------------------------------------------------------------------------

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
    await runWith(initCommand, makeDbServiceLive(dbPath))
    expect(existsSync(dbPath)).toBe(true)
  })

  it("creates all required tables", async () => {
    await runWith(initCommand, makeDbServiceLive(dbPath))

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
  })

  it("records migration 1 in schema_migrations", async () => {
    await runWith(initCommand, makeDbServiceLive(dbPath))

    const db = new Database(dbPath)
    const rows = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[]
    db.close()

    expect(rows).toHaveLength(1)
    expect(rows[0]?.version).toBe(1)
  })

  it("inserts the default global scope", async () => {
    await runWith(initCommand, makeDbServiceLive(dbPath))

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT id, kind, name FROM scopes WHERE id = 'global'")
      .get() as { id: string; kind: string; name: string } | undefined
    db.close()

    expect(row).toBeDefined()
    expect(row?.kind).toBe("global")
    expect(row?.name).toBe("global")
  })

  it("is idempotent — running init twice leaves one migration row and one global scope", async () => {
    const layer = makeDbServiceLive(dbPath)
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

    expect(migRows).toHaveLength(1)
    expect(scopeRows).toHaveLength(1)
  })

  it("does not touch ~/.pandora/pithos.sqlite", async () => {
    const realDbPath = join(homedir(), ".pandora", "pithos.sqlite")
    const mtimeBefore: number | null = existsSync(realDbPath)
      ? statSync(realDbPath).mtimeMs
      : null

    await runWith(initCommand, makeDbServiceLive(dbPath))

    const mtimeAfter: number | null = existsSync(realDbPath)
      ? statSync(realDbPath).mtimeMs
      : null

    expect(mtimeAfter).toBe(mtimeBefore)
  })
})

// ---------------------------------------------------------------------------
// CLI process smoke test
// ---------------------------------------------------------------------------

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

  it("PITHOS_DB=<temp> pithos init exits 0 and outputs valid JSON", () => {
    const binPath = join(import.meta.dirname, "../bin/pithos")
    const stdout = execFileSync(binPath, ["init"], {
      env: { ...process.env, PITHOS_DB: dbPath },
      encoding: "utf-8",
    })
    const parsed: unknown = JSON.parse(stdout)
    expect(parsed).toMatchObject({ ok: true, initialized: true })
  })

  it("PITHOS_DB=<temp> pithos init twice exits 0 both times (idempotent)", () => {
    const binPath = join(import.meta.dirname, "../bin/pithos")
    const env = { ...process.env, PITHOS_DB: dbPath }

    const out1 = execFileSync(binPath, ["init"], { env, encoding: "utf-8" })
    const out2 = execFileSync(binPath, ["init"], { env, encoding: "utf-8" })

    expect(JSON.parse(out1)).toMatchObject({ ok: true })
    expect(JSON.parse(out2)).toMatchObject({ ok: true })
  })

  it("creates DB in a nested directory that does not yet exist", () => {
    const nestedDbPath = join(tempDir, "nested", "sub", "pithos.sqlite")
    const binPath = join(import.meta.dirname, "../bin/pithos")
    execFileSync(binPath, ["init"], {
      env: { ...process.env, PITHOS_DB: nestedDbPath },
      encoding: "utf-8",
    })
    expect(existsSync(nestedDbPath)).toBe(true)
  })
})
