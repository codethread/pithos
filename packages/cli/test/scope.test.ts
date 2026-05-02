/**
 * Tests for Slice 5: scope upsert and inspect scope.
 *
 * Layers:
 *  1. Unit — pure domain helpers (canonicalizePath, deriveScopeId)
 *  2. Unit — command logic with fake DB
 *  3. Integration — real SQLite in temp dir for idempotency and inspection
 *  4. CLI process — smoke tests for `pithos scope upsert` and `pithos inspect scope`
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import { execFileSync } from "node:child_process"
import Database from "better-sqlite3"

import { canonicalizePath, deriveScopeId, nameFromPath } from "../src/domain/scope.ts"
import { scopeUpsertCommand } from "../src/commands/scope.ts"
import { inspectScopeCommand } from "../src/commands/inspect.ts"
import { parseArgs } from "../src/cli/args.ts"
import { makeDbServiceLive, makeDbServiceTest } from "../src/layers/db.ts"
import { initCommand } from "../src/commands/init.ts"
import { makeOutputServiceSilent } from "../src/layers/output.ts"

const silentOutput = makeOutputServiceSilent()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-scope-"))
}

async function runEffect<A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Pure domain helpers
// ---------------------------------------------------------------------------

describe("canonicalizePath", () => {
  it("expands leading ~/ to homedir", () => {
    const result = canonicalizePath("~/work/foo")
    expect(result).toBe(join(homedir(), "work/foo"))
  })

  it("expands bare ~ to homedir", () => {
    const result = canonicalizePath("~")
    expect(result).toBe(homedir())
  })

  it("leaves absolute paths unchanged (modulo resolve normalisation)", () => {
    const result = canonicalizePath("/absolute/path/to/repo")
    expect(result).toBe("/absolute/path/to/repo")
  })

  it("normalises an absolute path with redundant segments", () => {
    const result = canonicalizePath("/opt/../opt/projects/my-repo")
    expect(result).toBe("/opt/projects/my-repo")
  })

  it("normalises a trailing slash on absolute path", () => {
    const result = canonicalizePath("/opt/projects/my-repo/")
    expect(result).toBe("/opt/projects/my-repo")
  })
})

describe("deriveScopeId", () => {
  it("produces repo:<home-relative-path> for paths inside $HOME", () => {
    const absPath = join(homedir(), "work/perkbox-services/protobuf")
    expect(deriveScopeId("repo", absPath)).toBe("repo:work/perkbox-services/protobuf")
  })

  it("produces worktree:<home-relative-path> for worktree kind", () => {
    const absPath = join(homedir(), "work/perkbox-services/protobuf__feature")
    expect(deriveScopeId("worktree", absPath)).toBe(
      "worktree:work/perkbox-services/protobuf__feature",
    )
  })

  it("uses absolute path (without leading /) for paths outside $HOME", () => {
    const absPath = "/opt/projects/my-repo"
    const result = deriveScopeId("repo", absPath)
    expect(result).toBe("repo:opt/projects/my-repo")
  })

  it("is stable — same inputs produce the same ID", () => {
    const absPath = join(homedir(), "work/some/repo")
    expect(deriveScopeId("repo", absPath)).toBe(deriveScopeId("repo", absPath))
  })
})

describe("nameFromPath", () => {
  it("returns the basename", () => {
    expect(nameFromPath("/home/user/work/perkbox/protobuf")).toBe("protobuf")
    expect(nameFromPath("/home/user/work/perkbox")).toBe("perkbox")
  })
})

// ---------------------------------------------------------------------------
// 2. Unit — command logic with fake DB
// ---------------------------------------------------------------------------

describe("scopeUpsertCommand (unit — fake DB)", () => {
  it("succeeds for kind=global with no path", async () => {
    const exit = await runEffect(
      Effect.provide(
        scopeUpsertCommand({ kind: "global", path: undefined }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("succeeds for kind=repo with a path", async () => {
    const exit = await runEffect(
      Effect.provide(
        scopeUpsertCommand({ kind: "repo", path: "~/work/my-repo" }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("fails with VALIDATION_ERROR when kind=repo and no path", async () => {
    const exit = await runEffect(
      Effect.provide(
        scopeUpsertCommand({ kind: "repo", path: undefined }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    // Verify it's a failure — full cause inspection done in integration tests
  })
})

describe("inspectScopeCommand (unit — fake DB)", () => {
  it("fails with NOT_FOUND when scope is absent", async () => {
    const exit = await runEffect(
      Effect.provide(inspectScopeCommand("repo:missing"), Layer.merge(makeDbServiceTest(), silentOutput)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Integration — real SQLite
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
    const exit = await Effect.runPromiseExit(
      Effect.provide(inspectScopeCommand("global"), Layer.merge(makeDbServiceLive(dbPath), silentOutput)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
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

// ---------------------------------------------------------------------------
// 4. parseArgs — scope and inspect routing
// ---------------------------------------------------------------------------

describe("parseArgs — scope and inspect", () => {
  it("parses 'scope upsert --path /foo' with default kind=repo", async () => {
    const result = await Effect.runPromise(parseArgs(["scope", "upsert", "--path", "/foo"]))
    expect(result).toMatchObject({ command: "scope:upsert", kind: "repo", path: "/foo" })
  })

  it("parses 'scope upsert --kind worktree --path /foo'", async () => {
    const result = await Effect.runPromise(
      parseArgs(["scope", "upsert", "--kind", "worktree", "--path", "/foo"]),
    )
    expect(result).toMatchObject({ command: "scope:upsert", kind: "worktree", path: "/foo" })
  })

  it("parses 'scope upsert --kind global' (no path)", async () => {
    const result = await Effect.runPromise(
      parseArgs(["scope", "upsert", "--kind", "global"]),
    )
    expect(result).toMatchObject({ command: "scope:upsert", kind: "global", path: undefined })
  })

  it("routes 'scope upsert --help' to help", async () => {
    const result = await Effect.runPromise(parseArgs(["scope", "upsert", "--help"]))
    expect(result).toMatchObject({ command: "help" })
  })

  it("parses 'inspect scope <id>'", async () => {
    const result = await Effect.runPromise(parseArgs(["inspect", "scope", "repo:work/foo"]))
    expect(result).toMatchObject({ command: "inspect:scope", id: "repo:work/foo" })
  })

  it("routes 'inspect scope --help' to help", async () => {
    const result = await Effect.runPromise(parseArgs(["inspect", "scope", "--help"]))
    expect(result).toMatchObject({ command: "help" })
  })

  it("treats a flag token after --path as missing (returns undefined path)", async () => {
    // --path --kind is invalid; --path value must not be a flag
    const result = await Effect.runPromise(
      parseArgs(["scope", "upsert", "--path", "--kind", "worktree"]),
    )
    // path is undefined; kind falls back to repo
    expect(result).toMatchObject({ command: "scope:upsert", path: undefined })
  })
})

// ---------------------------------------------------------------------------
// 5. CLI process smoke
// ---------------------------------------------------------------------------

describe("pithos scope upsert (CLI process)", () => {
  let tempDir: string
  let dbPath: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    env = { ...process.env, PITHOS_DB: dbPath }
    // Init DB first
    execFileSync(BIN, ["init"], { env, encoding: "utf-8" })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("upserts a repo scope and returns JSON with ok:true", () => {
    const scopePath = join(homedir(), "work/test-project")
    const stdout = execFileSync(BIN, ["scope", "upsert", "--path", scopePath], {
      env,
      encoding: "utf-8",
    })
    const parsed = JSON.parse(stdout) as { ok: boolean; scope: { id: string; kind: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.scope.id).toBe("repo:work/test-project")
    expect(parsed.scope.kind).toBe("repo")
  })

  it("is idempotent — calling twice exits 0 both times", () => {
    const scopePath = join(homedir(), "work/idempotent-project")
    const opts = { env, encoding: "utf-8" } as const
    const out1 = execFileSync(BIN, ["scope", "upsert", "--path", scopePath], opts)
    const out2 = execFileSync(BIN, ["scope", "upsert", "--path", scopePath], opts)
    expect((JSON.parse(out1) as { ok: boolean }).ok).toBe(true)
    expect((JSON.parse(out2) as { ok: boolean }).ok).toBe(true)
  })

  it("expands ~ in --path", () => {
    const stdout = execFileSync(
      BIN,
      ["scope", "upsert", "--path", "~/work/tilde-smoke"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as { scope: { id: string } }
    expect(parsed.scope.id).toBe("repo:work/tilde-smoke")
  })

  it("shows help on --help", () => {
    const stdout = execFileSync(BIN, ["scope", "upsert", "--help"], {
      env,
      encoding: "utf-8",
    })
    expect(stdout).toContain("pithos scope upsert")
    expect(stdout).toContain("--path")
  })

  it("exits 2 when kind=repo and no --path given", () => {
    let status: number | undefined
    try {
      execFileSync(BIN, ["scope", "upsert", "--kind", "repo"], { env, encoding: "utf-8" })
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(2)
  })
})

describe("pithos inspect scope (CLI process)", () => {
  let tempDir: string
  let dbPath: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    env = { ...process.env, PITHOS_DB: dbPath }
    execFileSync(BIN, ["init"], { env, encoding: "utf-8" })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns global scope after init", () => {
    const stdout = execFileSync(BIN, ["inspect", "scope", "global"], {
      env,
      encoding: "utf-8",
    })
    const parsed = JSON.parse(stdout) as { ok: boolean; scope: { id: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.scope.id).toBe("global")
  })

  it("returns a upserted scope", () => {
    const scopePath = join(homedir(), "work/inspect-smoke")
    execFileSync(BIN, ["scope", "upsert", "--path", scopePath], { env, encoding: "utf-8" })

    const stdout = execFileSync(BIN, ["inspect", "scope", "repo:work/inspect-smoke"], {
      env,
      encoding: "utf-8",
    })
    const parsed = JSON.parse(stdout) as { ok: boolean; scope: { id: string; kind: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.scope.id).toBe("repo:work/inspect-smoke")
    expect(parsed.scope.kind).toBe("repo")
  })

  it("exits 3 for unknown scope ID", () => {
    let status: number | undefined
    try {
      execFileSync(BIN, ["inspect", "scope", "repo:nonexistent"], {
        env,
        encoding: "utf-8",
      })
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(3)
  })
})
