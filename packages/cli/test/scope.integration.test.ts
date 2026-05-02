/**
 * Integration tests for pithos scope — real SQLite. Unit coverage lives in src/commands/scope.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import Database from "better-sqlite3"

import { scopeUpsertCommand } from "../src/commands/scope.ts"
import { inspectScopeCommand } from "../src/commands/inspect.ts"
import { makeDbServiceLive } from "../src/layers/db.ts"
import { initCommand } from "../src/commands/init.ts"
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts"

const silentOutput = makeOutputServiceSilent()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-scope-"))
}

// ---------------------------------------------------------------------------
// Integration — real SQLite
// ---------------------------------------------------------------------------

describe("scopeUpsertCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    // Must init first so scopes table (and global scope) exist.
    await Effect.runPromise(Effect.provide(initCommand, Layer.merge(makeDbServiceLive(dbPath), silentOutput)))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("upserts a repo scope and returns the correct ID", async () => {
    const absPath = join(homedir(), "work/perkbox-services/protobuf")
    const expectedId = `repo:work/perkbox-services/protobuf`

    await Effect.runPromise(
      Effect.provide(
        scopeUpsertCommand({ kind: "repo", path: absPath }),
        Layer.merge(makeDbServiceLive(dbPath), silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT id, kind, name, canonical_path FROM scopes WHERE id = ?")
      .get(expectedId) as
      | { id: string; kind: string; name: string; canonical_path: string }
      | undefined
    db.close()

    expect(row).toBeDefined()
    expect(row?.id).toBe(expectedId)
    expect(row?.kind).toBe("repo")
    expect(row?.name).toBe("protobuf")
    expect(row?.canonical_path).toBe(absPath)
  })

  it("is idempotent — upserting the same path twice yields one row", async () => {
    const absPath = join(homedir(), "work/my-project")
    const layer = Layer.merge(makeDbServiceLive(dbPath), silentOutput)

    await Effect.runPromise(
      Effect.provide(scopeUpsertCommand({ kind: "repo", path: absPath }), layer),
    )
    await Effect.runPromise(
      Effect.provide(scopeUpsertCommand({ kind: "repo", path: absPath }), layer),
    )

    const db = new Database(dbPath)
    const rows = db
      .prepare("SELECT id FROM scopes WHERE id = ?")
      .all(`repo:work/my-project`) as { id: string }[]
    db.close()

    expect(rows).toHaveLength(1)
  })

  it("preserves created_at on repeated upsert", async () => {
    const absPath = join(homedir(), "work/stable-project")
    const layer = Layer.merge(makeDbServiceLive(dbPath), silentOutput)
    const id = "repo:work/stable-project"

    await Effect.runPromise(
      Effect.provide(scopeUpsertCommand({ kind: "repo", path: absPath }), layer),
    )

    const db = new Database(dbPath)
    const before = (
      db.prepare("SELECT created_at FROM scopes WHERE id = ?").get(id) as {
        created_at: string
      }
    ).created_at

    // Brief pause then upsert again.
    await new Promise((r) => setTimeout(r, 10))
    await Effect.runPromise(
      Effect.provide(scopeUpsertCommand({ kind: "repo", path: absPath }), layer),
    )

    const after = (
      db.prepare("SELECT created_at FROM scopes WHERE id = ?").get(id) as {
        created_at: string
      }
    ).created_at
    db.close()

    expect(after).toBe(before)
  })

  it("outputs JSON with ok:true and scope row for repo upsert", async () => {
    const absPath = join(homedir(), "work/output-test-project")
    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(
        scopeUpsertCommand({ kind: "repo", path: absPath }),
        Layer.merge(makeDbServiceLive(dbPath), out.layer),
      ),
    )

    expect(out.lines()).toHaveLength(1)
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      scope: { id: string; kind: string; name: string; canonical_path: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.scope.id).toBe("repo:work/output-test-project")
    expect(parsed.scope.kind).toBe("repo")
    expect(parsed.scope.name).toBe("output-test-project")
    expect(parsed.scope.canonical_path).toBe(absPath)
    expect(out.errorLines()).toHaveLength(0)
  })

  it("upserts a global scope (no path required)", async () => {
    await Effect.runPromise(
      Effect.provide(
        scopeUpsertCommand({ kind: "global", path: undefined }),
        Layer.merge(makeDbServiceLive(dbPath), silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT id, kind FROM scopes WHERE id = 'global'")
      .get() as { id: string; kind: string } | undefined
    db.close()

    expect(row?.id).toBe("global")
    expect(row?.kind).toBe("global")
  })

  it("expands ~ in --path correctly", async () => {
    const tildeRelPath = "~/work/tilde-test"
    const expectedId = "repo:work/tilde-test"

    await Effect.runPromise(
      Effect.provide(
        scopeUpsertCommand({ kind: "repo", path: tildeRelPath }),
        Layer.merge(makeDbServiceLive(dbPath), silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT id FROM scopes WHERE id = ?")
      .get(expectedId) as { id: string } | undefined
    db.close()

    expect(row?.id).toBe(expectedId)
  })
})

describe("inspectScopeCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    await Effect.runPromise(Effect.provide(initCommand, Layer.merge(makeDbServiceLive(dbPath), silentOutput)))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns the global scope after init", async () => {
    const out = makeOutputServiceTest()
    const exit = await Effect.runPromiseExit(
      Effect.provide(inspectScopeCommand("global"), Layer.merge(makeDbServiceLive(dbPath), out.layer)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(out.lines()).toHaveLength(1)
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      scope: { id: string; kind: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.scope.id).toBe("global")
    expect(out.errorLines()).toHaveLength(0)
  })

  it("fails NOT_FOUND for unknown scope ID", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(inspectScopeCommand("repo:does-not-exist"), Layer.merge(makeDbServiceLive(dbPath), silentOutput)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("returns the correct row after upsert", async () => {
    const absPath = join(homedir(), "work/inspect-test")
    const id = "repo:work/inspect-test"
    const layer = Layer.merge(makeDbServiceLive(dbPath), silentOutput)

    await Effect.runPromise(
      Effect.provide(scopeUpsertCommand({ kind: "repo", path: absPath }), layer),
    )

    const exit = await Effect.runPromiseExit(
      Effect.provide(inspectScopeCommand(id), layer),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})


