/**
 * Integration tests for `pithos init` — real SQLite + CLI subprocess.
 * Unit coverage lives in src/commands/init.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import { execFileSync } from "node:child_process"
import Database from "better-sqlite3"

import { initCommand } from "../src/commands/init.ts"
import { makeDbServiceLive } from "../src/layers/db.ts"
import { makeOutputServiceSilent } from "../src/layers/output.ts"

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
  })

  it("records migration 1 in schema_migrations", async () => {
    await runWith(initCommand, Layer.merge(makeDbServiceLive(dbPath), silentOutput))

    const db = new Database(dbPath)
    const rows = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[]
    db.close()

    expect(rows).toHaveLength(1)
    expect(rows[0]?.version).toBe(1)
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

  it("is idempotent — running init twice leaves one migration row and one global scope", async () => {
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

    expect(migRows).toHaveLength(1)
    expect(scopeRows).toHaveLength(1)
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
