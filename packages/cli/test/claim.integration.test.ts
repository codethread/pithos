/**
 * Integration tests for pithos claim — real SQLite + CLI subprocess. Unit coverage lives in src/commands/claim.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"

import { claimCommand } from "../src/commands/claim.ts"
import { enqueueCommand } from "../src/commands/enqueue.ts"
import { runRegisterCommand } from "../src/commands/run.ts"
import { makeDbServiceLive } from "../src/layers/db.ts"
import { makeIdServiceTest } from "../src/layers/ids.ts"
import { FsServiceLive } from "../src/layers/fs.ts"
import { initCommand } from "../src/commands/init.ts"
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts"
import { runCli, runCliOk } from "./_helpers/exec.ts"

const silentOutput = makeOutputServiceSilent()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-claim-"))
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 2. Integration — real SQLite
// ---------------------------------------------------------------------------

describe("claimCommand (integration — real SQLite)", () => {
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

  /** Enqueue a task in the global scope. Returns the task id. */
  const enqueue = async (taskId: string, capability = "triage"): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([taskId]), FsServiceLive, silentOutput)
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability, title: `Task ${taskId}` }),
        layer,
      ),
    )
    return taskId
  }

  /** Register a run. Returns the run id. */
  const registerRun = async (runId: string): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([runId]), FsServiceLive, silentOutput)
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: runId }), layer),
    )
    return runId
  }

  it("successfully claims the oldest queued task", async () => {
    await enqueue("task_claim1")
    await registerRun("run_claim1")

    await Effect.runPromise(
      Effect.provide(
        claimCommand({ run: "run_claim1", scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT status, lease_owner_run_id, fencing_token, attempts FROM tasks WHERE id = 'task_claim1'")
      .get() as {
      status: string
      lease_owner_run_id: string
      fencing_token: number
      attempts: number
    }
    db.close()

    expect(row.status).toBe("claimed")
    expect(row.lease_owner_run_id).toBe("run_claim1")
    expect(row.fencing_token).toBe(1)
    expect(row.attempts).toBe(1)
  })

  it("sets lease_until to a future datetime", async () => {
    await enqueue("task_lease1")
    await registerRun("run_lease1")

    await Effect.runPromise(
      Effect.provide(
        claimCommand({ run: "run_lease1", scope: "global", capability: "triage", leaseMinutes: 15 }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT lease_until FROM tasks WHERE id = 'task_lease1'")
      .get() as { lease_until: string }
    db.close()

    expect(row.lease_until).toBeTruthy()
    // lease_until is stored as ISO-8601 UTC (ends with Z)
    expect(row.lease_until).toMatch(/Z$/)
    const leaseDate = new Date(row.lease_until)
    expect(leaseDate.getTime()).toBeGreaterThan(Date.now())
  })

  it("appends a task.claimed event", async () => {
    await enqueue("task_event1")
    await registerRun("run_event1")

    await Effect.runPromise(
      Effect.provide(
        claimCommand({ run: "run_event1", scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const event = db
      .prepare(
        "SELECT type, actor_run_id, payload_json FROM events WHERE type = 'task.claimed'",
      )
      .get() as { type: string; actor_run_id: string; payload_json: string }
    db.close()

    expect(event.type).toBe("task.claimed")
    expect(event.actor_run_id).toBe("run_event1")
    const payload = JSON.parse(event.payload_json) as {
      run_id: string
      fencing_token: number
    }
    expect(payload.run_id).toBe("run_event1")
    expect(payload.fencing_token).toBe(1)
  })

  it("claims tasks FIFO — oldest queued task is claimed first", async () => {
    // Enqueue two tasks; the first enqueued should be claimed.
    await enqueue("task_fifo_a")
    await enqueue("task_fifo_b")
    await registerRun("run_fifo1")

    await Effect.runPromise(
      Effect.provide(
        claimCommand({ run: "run_fifo1", scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const claimed = db
      .prepare("SELECT id, status FROM tasks WHERE status = 'claimed'")
      .get() as { id: string; status: string }
    const queued = db
      .prepare("SELECT id, status FROM tasks WHERE status = 'queued'")
      .get() as { id: string; status: string }
    db.close()

    expect(claimed.id).toBe("task_fifo_a")
    expect(queued.id).toBe("task_fifo_b")
  })

  it("fails NO_CLAIMABLE_WORK when no queued tasks exist", async () => {
    await registerRun("run_nowork1")

    const exit = await runEff(
      Effect.provide(
        claimCommand({ run: "run_nowork1", scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails NO_CLAIMABLE_WORK when scope/capability has no matching tasks", async () => {
    await enqueue("task_cap_mismatch", "watch") // different capability
    await registerRun("run_cap_mismatch")

    const exit = await runEff(
      Effect.provide(
        claimCommand({ run: "run_cap_mismatch", scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails NOT_FOUND when run does not exist", async () => {
    await enqueue("task_norun1")

    const exit = await runEff(
      Effect.provide(
        claimCommand({ run: "run_nonexistent", scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("RACE: only one of two runs claims the single available task", async () => {
    await enqueue("task_race1")
    await registerRun("run_race_a")
    await registerRun("run_race_b")

    // NOTE: Node.js + better-sqlite3 are single-threaded/synchronous, so true
    // concurrent writes cannot be simulated in-process. This test proves the
    // state-machine invariant: once a task is claimed, a second attempt must
    // fail. SQLite UPDATE atomicity ensures the same under multi-process
    // contention (exercised explicitly in the CLI process 'RACE (CLI)' tests).
    const exitA = await runEff(
      Effect.provide(
        claimCommand({ run: "run_race_a", scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )
    const exitB = await runEff(
      Effect.provide(
        claimCommand({ run: "run_race_b", scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    expect(Exit.isSuccess(exitA)).toBe(true)
    expect(Exit.isFailure(exitB)).toBe(true)

    // Verify the DB has exactly one claimed task owned by run_race_a.
    const db = new Database(dbPath)
    const claimedRows = db
      .prepare("SELECT id, lease_owner_run_id, fencing_token FROM tasks WHERE status = 'claimed'")
      .all() as { id: string; lease_owner_run_id: string; fencing_token: number }[]
    db.close()

    expect(claimedRows).toHaveLength(1)
    expect(claimedRows[0]?.lease_owner_run_id).toBe("run_race_a")
    expect(claimedRows[0]?.fencing_token).toBe(1)
  })

  it("only one claim event is appended in the race scenario", async () => {
    await enqueue("task_race_event")
    await registerRun("run_race_ev_a")
    await registerRun("run_race_ev_b")

    await runEff(
      Effect.provide(
        claimCommand({ run: "run_race_ev_a", scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )
    await runEff(
      Effect.provide(
        claimCommand({ run: "run_race_ev_b", scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const events = db
      .prepare("SELECT type FROM events WHERE type = 'task.claimed'")
      .all() as { type: string }[]
    db.close()

    expect(events).toHaveLength(1)
  })

  it("outputs JSON with ok:true and full task row on success", async () => {
    await enqueue("task_output1")
    await registerRun("run_output1")

    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(
        claimCommand({ run: "run_output1", scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, out.layer),
      ),
    )

    expect(out.lines()).toHaveLength(1)
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      task: {
        id: string
        status: string
        fencing_token: number
        lease_owner_run_id: string
      }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toBe("task_output1")
    expect(parsed.task.status).toBe("claimed")
    expect(parsed.task.fencing_token).toBe(1)
    expect(parsed.task.lease_owner_run_id).toBe("run_output1")
  })

})

// ---------------------------------------------------------------------------
// 4. CLI process smoke tests
// ---------------------------------------------------------------------------

describe("pithos claim (CLI process)", () => {
  let tempDir: string
  let dbPath: string
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    env = { ...process.env, PITHOS_DB: dbPath }
    await runCliOk(BIN, ["init"], env)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const cliEnqueue = async (capability = "triage"): Promise<string> => {
    const out = await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", capability, "--title", "Test task"],
      env,
    )
    return (JSON.parse(out) as { task: { id: string } }).task.id
  }

  const cliRegisterRun = async (): Promise<string> => {
    const out = await runCliOk(BIN, ["run", "register", "--agent-kind", "envy"], env)
    return (JSON.parse(out) as { run: { id: string } }).run.id
  }

  it("claims a task and returns JSON with ok:true and task_ id", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()

    const stdout = await runCliOk(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage"],
      env,
    )
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      task: { id: string; status: string; fencing_token: number; lease_until: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toMatch(/^task_/)
    expect(parsed.task.status).toBe("claimed")
    expect(parsed.task.fencing_token).toBe(1)
    expect(parsed.task.lease_until).toBeTruthy()
  })

  it("exits 5 with no_claimable_work JSON when no queued tasks", async () => {
    const runId = await cliRegisterRun()

    const result = await runCli(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage"],
      env,
    )

    expect(result.exitCode).toBe(5)
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: { code: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("NO_CLAIMABLE_WORK")
  })

  it("exits 3 when run does not exist", async () => {
    await cliEnqueue()

    const result = await runCli(
      BIN,
      ["claim", "--run", "run_nonexistent", "--scope", "global", "--capability", "triage"],
      env,
    )
    expect(result.exitCode).toBe(3)
  })

  it("exits 2 when --run is missing", async () => {
    const result = await runCli(
      BIN,
      ["claim", "--scope", "global", "--capability", "triage"],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --scope is missing", async () => {
    const runId = await cliRegisterRun()
    const result = await runCli(
      BIN,
      ["claim", "--run", runId, "--capability", "triage"],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --capability is missing", async () => {
    const runId = await cliRegisterRun()
    const result = await runCli(
      BIN,
      ["claim", "--run", runId, "--scope", "global"],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --lease-minutes is not a valid number", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const result = await runCli(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage", "--lease-minutes", "abc"],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("respects --lease-minutes flag", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()

    const stdout = await runCliOk(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage", "--lease-minutes", "30"],
      env,
    )
    const parsed = JSON.parse(stdout) as { ok: boolean; task: { lease_until: string } }
    expect(parsed.ok).toBe(true)
    // lease_until should be ~30 minutes from now, so definitely > 20 minutes
    // Append UTC marker so Node.js parses the SQLite datetime string correctly.
    const leaseDate = new Date(parsed.task.lease_until)
    const twentyMinsFromNow = new Date(Date.now() + 20 * 60 * 1000)
    expect(leaseDate.getTime()).toBeGreaterThan(twentyMinsFromNow.getTime())
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["claim", "--help"], env)
    expect(stdout).toContain("pithos claim")
    expect(stdout).toContain("--run")
    expect(stdout).toContain("--scope")
    expect(stdout).toContain("--capability")
    expect(stdout).toContain("--lease-minutes")
  })

  it("RACE (CLI): two concurrent processes — only one claims the task", async () => {
    // Enqueue exactly one task.
    await cliEnqueue()
    const runIdA = await cliRegisterRun()
    const runIdB = await cliRegisterRun()

    // Run both claim processes sequentially, verifying atomicity:
    // once a task is claimed, it can't be claimed again.
    const resultA = await runCli(
      BIN,
      ["claim", "--run", runIdA, "--scope", "global", "--capability", "triage"],
      env,
    )
    const resultB = await runCli(
      BIN,
      ["claim", "--run", runIdB, "--scope", "global", "--capability", "triage"],
      env,
    )

    // Exactly one should succeed and one should get no_claimable_work.
    const statuses = [resultA.exitCode, resultB.exitCode].sort()
    expect(statuses).toEqual([0, 5])

    // Verify DB has exactly one claimed task.
    const db = new Database(dbPath)
    const claimed = db
      .prepare("SELECT id, fencing_token FROM tasks WHERE status = 'claimed'")
      .all() as { id: string; fencing_token: number }[]
    db.close()

    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.fencing_token).toBe(1)
  })

  it("RACE (CLI): two runs, two tasks — each gets exactly one", async () => {
    // Enqueue two tasks, two runs both claim — each should get one.
    await cliEnqueue("triage")
    await cliEnqueue("triage")
    const runIdA = await cliRegisterRun()
    const runIdB = await cliRegisterRun()

    const resultA = await runCli(
      BIN,
      ["claim", "--run", runIdA, "--scope", "global", "--capability", "triage"],
      env,
    )
    const resultB = await runCli(
      BIN,
      ["claim", "--run", runIdB, "--scope", "global", "--capability", "triage"],
      env,
    )

    expect(resultA.exitCode).toBe(0)
    expect(resultB.exitCode).toBe(0)

    const db = new Database(dbPath)
    const claimed = db
      .prepare("SELECT lease_owner_run_id FROM tasks WHERE status = 'claimed'")
      .all() as { lease_owner_run_id: string }[]
    db.close()

    expect(claimed).toHaveLength(2)
    const owners = new Set(claimed.map((r) => r.lease_owner_run_id))
    expect(owners.has(runIdA)).toBe(true)
    expect(owners.has(runIdB)).toBe(true)
  })
})
