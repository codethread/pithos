/**
 * Integration tests for pithos run — real SQLite + CLI subprocess. Unit coverage lives in src/commands/run.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import Database from "better-sqlite3"

import { runRegisterCommand, runEndCommand } from "../src/commands/run.ts"
import { inspectRunCommand } from "../src/commands/inspect.ts"
import { makeDbServiceLive } from "../src/layers/db.ts"
import { makeIdServiceTest, IdServiceLive } from "../src/layers/ids.ts"
import { initCommand } from "../src/commands/init.ts"
import { scopeUpsertCommand } from "../src/commands/scope.ts"
import { makeOutputServiceSilent } from "../src/layers/output.ts"

const silentOutput = makeOutputServiceSilent()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-run-"))
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 2. Integration — real SQLite
// ---------------------------------------------------------------------------

describe("runRegisterCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    dbLayer = makeDbServiceLive(dbPath)
    await Effect.runPromise(Effect.provide(initCommand, Layer.merge(dbLayer, silentOutput)))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("creates a run with status=starting", async () => {
    const layer = Layer.mergeAll(dbLayer, IdServiceLive, silentOutput)
    await Effect.runPromise(Effect.provide(runRegisterCommand({ agentKind: "envy" }), layer))

    const db = new Database(dbPath)
    const rows = db
      .prepare("SELECT status FROM runs WHERE agent_kind = 'envy'")
      .all() as { status: string }[]
    db.close()

    expect(rows).toHaveLength(1)
    const [firstRow] = rows
    expect(firstRow?.status).toBe("starting")
  })

  it("generates a run_ prefixed ID", async () => {
    const layer = Layer.mergeAll(dbLayer, IdServiceLive, silentOutput)
    await Effect.runPromise(Effect.provide(runRegisterCommand({ agentKind: "envy" }), layer))

    const db = new Database(dbPath)
    const rows = db.prepare("SELECT id FROM runs").all() as { id: string }[]
    db.close()

    const [rowId] = rows
    expect(rowId?.id).toMatch(/^run_/)
  })

  it("appends a run.registered lifecycle event", async () => {
    const layer = Layer.mergeAll(dbLayer, IdServiceLive, silentOutput)
    await Effect.runPromise(Effect.provide(runRegisterCommand({ agentKind: "envy" }), layer))

    const db = new Database(dbPath)
    const events = db
      .prepare("SELECT type FROM events WHERE type = 'run.registered'")
      .all() as { type: string }[]
    db.close()

    expect(events).toHaveLength(1)
    const [firstRegEvent] = events
    expect(firstRegEvent?.type).toBe("run.registered")
  })

  it("stores scope_id and cwd when provided", async () => {
    const scopePath = join(process.env.HOME ?? "/tmp", "work/run-scope-test")
    await Effect.runPromise(
      Effect.provide(scopeUpsertCommand({ kind: "repo", path: scopePath }), Layer.merge(dbLayer, silentOutput)),
    )

    const layer = Layer.mergeAll(dbLayer, IdServiceLive, silentOutput)
    await Effect.runPromise(
      Effect.provide(
        runRegisterCommand({
          agentKind: "envy",
          scopeId: "repo:work/run-scope-test",
          cwd: scopePath,
        }),
        layer,
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT scope_id, cwd FROM runs WHERE agent_kind = 'envy'")
      .get() as { scope_id: string; cwd: string }
    db.close()

    expect(row.scope_id).toBe("repo:work/run-scope-test")
    expect(row.cwd).toBe(scopePath)
  })

  it("is idempotent — re-registering with same run ID returns existing run", async () => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([]), silentOutput)

    // First call: run_fixed doesn't exist yet, so it inserts
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_fixed" }), layer),
    )

    // Second call: run_fixed already exists → returns it unchanged
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "toil", run: "run_fixed" }), layer),
    )

    const db = new Database(dbPath)
    const rows = db
      .prepare("SELECT agent_kind FROM runs WHERE id = 'run_fixed'")
      .all() as { agent_kind: string }[]
    db.close()

    // Only one row, still the original agent kind
    expect(rows).toHaveLength(1)
    const [fixedRow] = rows
    expect(fixedRow?.agent_kind).toBe("envy")
  })

  it("idempotent re-registration does not insert a second run.registered event", async () => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([]), silentOutput)

    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_idem" }), layer),
    )
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_idem" }), layer),
    )

    const db = new Database(dbPath)
    const events = db
      .prepare("SELECT type FROM events WHERE type = 'run.registered'")
      .all() as { type: string }[]
    db.close()

    expect(events).toHaveLength(1)
  })
})

describe("runEndCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    dbLayer = makeDbServiceLive(dbPath)
    await Effect.runPromise(Effect.provide(initCommand, Layer.merge(dbLayer, silentOutput)))
    // Seed a run to end
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([]), silentOutput)
    await Effect.runPromise(
      Effect.provide(
        runRegisterCommand({ agentKind: "envy", run: "run_to_end" }),
        layer,
      ),
    )
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("sets ended_at on a run when ended", async () => {
    await Effect.runPromise(
      Effect.provide(
        runEndCommand({ run: "run_to_end", status: "ended" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT status, ended_at FROM runs WHERE id = 'run_to_end'")
      .get() as { status: string; ended_at: string | null } | undefined
    db.close()

    expect(row?.status).toBe("ended")
    expect(row?.ended_at).not.toBeNull()
  })

  it("appends a run.ended lifecycle event", async () => {
    await Effect.runPromise(
      Effect.provide(
        runEndCommand({ run: "run_to_end", status: "ended", summary: "completed" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const events = db
      .prepare("SELECT type, payload_json FROM events WHERE type = 'run.ended'")
      .all() as { type: string; payload_json: string }[]
    db.close()

    expect(events).toHaveLength(1)
    const [endedEvent] = events
    expect(endedEvent?.type).toBe("run.ended")
    const payload = JSON.parse(endedEvent?.payload_json ?? "{}") as {
      status: string
      summary: string
    }
    expect(payload.status).toBe("ended")
    expect(payload.summary).toBe("completed")
  })

  it("stores summary in last_summary", async () => {
    await Effect.runPromise(
      Effect.provide(
        runEndCommand({ run: "run_to_end", status: "failed", summary: "crashed" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const summaryRow = db
      .prepare("SELECT last_summary, status FROM runs WHERE id = 'run_to_end'")
      .get() as { last_summary: string; status: string } | undefined
    db.close()

    expect(summaryRow?.last_summary).toBe("crashed")
    expect(summaryRow?.status).toBe("failed")
  })

  it("fails NOT_FOUND for non-existent run", async () => {
    const exit = await runEff(
      Effect.provide(
        runEndCommand({ run: "run_ghost", status: "ended" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("is idempotent — ending an already-ended run returns success without re-appending an event", async () => {
    await Effect.runPromise(
      Effect.provide(runEndCommand({ run: "run_to_end", status: "ended" }), Layer.merge(dbLayer, silentOutput)),
    )

    // Second call on an already-ended run
    const exit = await runEff(
      Effect.provide(runEndCommand({ run: "run_to_end", status: "ended" }), Layer.merge(dbLayer, silentOutput)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)

    // Exactly one run.ended event total
    const db = new Database(dbPath)
    const events = db
      .prepare("SELECT type FROM events WHERE type = 'run.ended'")
      .all() as { type: string }[]
    db.close()
    expect(events).toHaveLength(1)
  })

  it("supports cancellation status", async () => {
    await Effect.runPromise(
      Effect.provide(
        runEndCommand({ run: "run_to_end", status: "cancelled" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const cancelRow = db
      .prepare("SELECT status FROM runs WHERE id = 'run_to_end'")
      .get() as { status: string } | undefined
    db.close()

    expect(cancelRow?.status).toBe("cancelled")
  })
})

describe("inspectRunCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    dbLayer = makeDbServiceLive(dbPath)
    await Effect.runPromise(Effect.provide(initCommand, Layer.merge(dbLayer, silentOutput)))
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([]), silentOutput)
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_inspect" }), layer),
    )
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns the run after registration", async () => {
    const exit = await runEff(
      Effect.provide(inspectRunCommand("run_inspect"), Layer.merge(dbLayer, silentOutput)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("fails NOT_FOUND for unknown run ID", async () => {
    const exit = await runEff(
      Effect.provide(inspectRunCommand("run_unknown"), Layer.merge(dbLayer, silentOutput)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("shows ended_at after run is ended", async () => {
    await Effect.runPromise(
      Effect.provide(runEndCommand({ run: "run_inspect", status: "ended" }), Layer.merge(dbLayer, silentOutput)),
    )
    const exit = await runEff(
      Effect.provide(inspectRunCommand("run_inspect"), Layer.merge(dbLayer, silentOutput)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. CLI process smoke tests
// ---------------------------------------------------------------------------

describe("pithos run register (CLI process)", () => {
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

  it("registers a run and returns JSON with ok:true", () => {
    const stdout = execFileSync(
      BIN,
      ["run", "register", "--agent-kind", "envy"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as { ok: boolean; run: { id: string; status: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.run.id).toMatch(/^run_/)
    expect(parsed.run.status).toBe("starting")
  })

  it("exits 2 when --agent-kind is missing", () => {
    let status: number | undefined
    try {
      execFileSync(BIN, ["run", "register"], { env, encoding: "utf-8" })
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(2)
  })

  it("shows help on --help", () => {
    const stdout = execFileSync(BIN, ["run", "register", "--help"], { env, encoding: "utf-8" })
    expect(stdout).toContain("pithos run register")
    expect(stdout).toContain("--agent-kind")
  })

  it("is idempotent with explicit --run ID", () => {
    const opts = { env, encoding: "utf-8" } as const
    const out1 = execFileSync(
      BIN,
      ["run", "register", "--agent-kind", "envy", "--run", "run_cli_idem"],
      opts,
    )
    const out2 = execFileSync(
      BIN,
      ["run", "register", "--agent-kind", "toil", "--run", "run_cli_idem"],
      opts,
    )
    const r1 = JSON.parse(out1) as { run: { agent_kind: string } }
    const r2 = JSON.parse(out2) as { run: { agent_kind: string } }
    // Second call returns the original run unchanged
    expect(r1.run.agent_kind).toBe("envy")
    expect(r2.run.agent_kind).toBe("envy")
  })
})

describe("pithos run end (CLI process)", () => {
  let tempDir: string
  let dbPath: string
  let env: NodeJS.ProcessEnv
  let runId: string

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    env = { ...process.env, PITHOS_DB: dbPath }
    execFileSync(BIN, ["init"], { env, encoding: "utf-8" })
    const out = execFileSync(
      BIN,
      ["run", "register", "--agent-kind", "envy"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(out) as { run: { id: string } }
    runId = parsed.run.id
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("ends a run and returns JSON with ok:true and ended_at set", () => {
    const stdout = execFileSync(BIN, ["run", "end", "--run", runId], {
      env,
      encoding: "utf-8",
    })
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      run: { status: string; ended_at: string | null }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.run.status).toBe("ended")
    expect(parsed.run.ended_at).not.toBeNull()
  })

  it("ends a run with --status failed", () => {
    const stdout = execFileSync(
      BIN,
      ["run", "end", "--run", runId, "--status", "failed", "--summary", "something went wrong"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as { run: { status: string; last_summary: string } }
    expect(parsed.run.status).toBe("failed")
    expect(parsed.run.last_summary).toBe("something went wrong")
  })

  it("exits 2 when --run is missing", () => {
    let status: number | undefined
    try {
      execFileSync(BIN, ["run", "end"], { env, encoding: "utf-8" })
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(2)
  })

  it("exits 3 for unknown run ID", () => {
    let status: number | undefined
    try {
      execFileSync(BIN, ["run", "end", "--run", "run_nonexistent"], { env, encoding: "utf-8" })
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(3)
  })

  it("exits 2 for an invalid --status value", () => {
    let status: number | undefined
    try {
      execFileSync(BIN, ["run", "end", "--run", runId, "--status", "typo"], {
        env,
        encoding: "utf-8",
      })
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(2)
  })

  it("shows help on --help", () => {
    const stdout = execFileSync(BIN, ["run", "end", "--help"], { env, encoding: "utf-8" })
    expect(stdout).toContain("pithos run end")
    expect(stdout).toContain("--run")
  })
})

describe("pithos inspect run (CLI process)", () => {
  let tempDir: string
  let dbPath: string
  let env: NodeJS.ProcessEnv
  let runId: string

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    env = { ...process.env, PITHOS_DB: dbPath }
    execFileSync(BIN, ["init"], { env, encoding: "utf-8" })
    const out = execFileSync(
      BIN,
      ["run", "register", "--agent-kind", "envy"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(out) as { run: { id: string } }
    runId = parsed.run.id
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns a registered run", () => {
    const stdout = execFileSync(BIN, ["inspect", "run", runId], { env, encoding: "utf-8" })
    const parsed = JSON.parse(stdout) as { ok: boolean; run: { id: string; agent_kind: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.run.id).toBe(runId)
    expect(parsed.run.agent_kind).toBe("envy")
  })

  it("returns updated state after run end", () => {
    execFileSync(BIN, ["run", "end", "--run", runId], { env, encoding: "utf-8" })
    const stdout = execFileSync(BIN, ["inspect", "run", runId], { env, encoding: "utf-8" })
    const parsed = JSON.parse(stdout) as { run: { status: string; ended_at: string | null } }
    expect(parsed.run.status).toBe("ended")
    expect(parsed.run.ended_at).not.toBeNull()
  })

  it("exits 3 for unknown run ID", () => {
    let status: number | undefined
    try {
      execFileSync(BIN, ["inspect", "run", "run_unknown"], { env, encoding: "utf-8" })
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(3)
  })
})
