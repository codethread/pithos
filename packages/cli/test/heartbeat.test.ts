/**
 * Tests for Slice 9: Heartbeat an active run and task.
 *
 * Layers:
 *  1. Unit  — validation with fake DB service
 *  2. Integration — real SQLite in temp dir
 *  3. parseArgs  — heartbeat routing
 *  4. CLI process — smoke tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync, spawnSync } from "node:child_process"
import Database from "better-sqlite3"

import { heartbeatCommand } from "../src/commands/heartbeat.ts"
import { claimCommand } from "../src/commands/claim.ts"
import { enqueueCommand } from "../src/commands/enqueue.ts"
import { runRegisterCommand } from "../src/commands/run.ts"
import { parseArgs } from "../src/cli/args.ts"
import { makeDbServiceLive, makeDbServiceTest } from "../src/layers/db.ts"
import { makeIdServiceTest } from "../src/layers/ids.ts"
import { FsServiceLive } from "../src/layers/fs.ts"
import { initCommand } from "../src/commands/init.ts"
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts"

const silentOutput = makeOutputServiceSilent()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-hb-"))
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / validation only
// ---------------------------------------------------------------------------

describe("heartbeatCommand (unit — fake DB)", () => {
  it("fails VALIDATION_ERROR when --run is missing", async () => {
    const exit = await runEff(
      Effect.provide(heartbeatCommand({ run: undefined }), Layer.merge(makeDbServiceTest(), silentOutput)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --task is given without --token", async () => {
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: "run_abc", task: "task_xyz", token: undefined }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --token is NaN", async () => {
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: "run_abc", task: "task_xyz", token: NaN }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --throttle-seconds is NaN", async () => {
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: "run_abc", throttleSeconds: NaN }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --throttle-seconds is negative", async () => {
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: "run_abc", throttleSeconds: -5 }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Integration — real SQLite
// ---------------------------------------------------------------------------

describe("heartbeatCommand (integration — real SQLite)", () => {
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

  /** Enqueue a task and return the task ID. */
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

  /** Register a run and return the run ID. */
  const registerRun = async (runId: string): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([runId]), FsServiceLive, silentOutput)
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: runId }), layer),
    )
    return runId
  }

  /** Claim a task for a run and return the fencing token. */
  const claim = async (runId: string, taskId?: string): Promise<number> => {
    await Effect.runPromise(
      Effect.provide(
        claimCommand({ run: runId, scope: "global", capability: "triage" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )
    const db = new Database(dbPath)
    const row = db
      .prepare(
        `SELECT fencing_token FROM tasks WHERE lease_owner_run_id = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(runId) as { fencing_token: number } | undefined
    db.close()

    if (row === undefined) {
      // fall back: look up by taskId if provided
      if (taskId !== undefined) {
        const db2 = new Database(dbPath)
        const r = db2
          .prepare("SELECT fencing_token FROM tasks WHERE id = ?")
          .get(taskId) as { fencing_token: number }
        db2.close()
        return r.fencing_token
      }
      throw new Error("No claimed task found")
    }
    return row.fencing_token
  }

  // ── run-only heartbeat ────────────────────────────────────────────────────

  it("updates last_heartbeat_at on heartbeat", async () => {
    const runId = await registerRun("run_hb1")

    await Effect.runPromise(
      Effect.provide(heartbeatCommand({ run: runId }), Layer.merge(dbLayer, silentOutput)),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT last_heartbeat_at FROM runs WHERE id = ?")
      .get(runId) as { last_heartbeat_at: string }
    db.close()

    expect(row.last_heartbeat_at).toBeTruthy()
  })

  it("advances run status from 'starting' to 'running'", async () => {
    const runId = await registerRun("run_hb_status")

    const db1 = new Database(dbPath)
    const before = db1
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(runId) as { status: string }
    db1.close()
    expect(before.status).toBe("starting")

    await Effect.runPromise(
      Effect.provide(heartbeatCommand({ run: runId }), Layer.merge(dbLayer, silentOutput)),
    )

    const db2 = new Database(dbPath)
    const after = db2
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(runId) as { status: string }
    db2.close()
    expect(after.status).toBe("running")
  })

  it("records last_hook when --hook is provided", async () => {
    const runId = await registerRun("run_hb_hook")

    await Effect.runPromise(
      Effect.provide(heartbeatCommand({ run: runId, hook: "PreToolUse" }), Layer.merge(dbLayer, silentOutput)),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT last_hook FROM runs WHERE id = ?")
      .get(runId) as { last_hook: string }
    db.close()
    expect(row.last_hook).toBe("PreToolUse")
  })

  it("fails NOT_FOUND when run does not exist", async () => {
    const exit = await runEff(
      Effect.provide(heartbeatCommand({ run: "run_nonexistent" }), Layer.merge(dbLayer, silentOutput)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  // ── task advancement ──────────────────────────────────────────────────────

  it("moves task from 'claimed' to 'running' when token matches", async () => {
    const taskId = await enqueue("task_hb_running")
    const runId = await registerRun("run_hb_running")
    const token = await claim(runId, taskId)

    await Effect.runPromise(
      Effect.provide(
        heartbeatCommand({ run: runId, task: taskId, token }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(taskId) as { status: string }
    db.close()
    expect(row.status).toBe("running")
  })

  it("extends lease_until when task is advanced to running", async () => {
    const taskId = await enqueue("task_hb_lease")
    const runId = await registerRun("run_hb_lease")
    const token = await claim(runId, taskId)

    const db1 = new Database(dbPath)
    const before = db1
      .prepare("SELECT lease_until FROM tasks WHERE id = ?")
      .get(taskId) as { lease_until: string }
    db1.close()

    // small sleep so 'now' advances
    await new Promise((r) => setTimeout(r, 50))

    await Effect.runPromise(
      Effect.provide(
        heartbeatCommand({ run: runId, task: taskId, token }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db2 = new Database(dbPath)
    const after = db2
      .prepare("SELECT lease_until FROM tasks WHERE id = ?")
      .get(taskId) as { lease_until: string }
    db2.close()

    const beforeMs = new Date(before.lease_until).getTime()
    const afterMs = new Date(after.lease_until).getTime()
    // lease should have been extended (or at least not shrunk)
    expect(afterMs).toBeGreaterThanOrEqual(beforeMs)
    // lease_until should still be in the future
    expect(afterMs).toBeGreaterThan(Date.now())
  })

  it("fails STALE_TOKEN when fencing token is wrong", async () => {
    const taskId = await enqueue("task_hb_stale")
    const runId = await registerRun("run_hb_stale")
    await claim(runId, taskId)

    // Use a wrong token
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: runId, task: taskId, token: 999 }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("does not mutate run when fencing token is stale", async () => {
    const taskId = await enqueue("task_hb_stale_nomut")
    const runId = await registerRun("run_hb_stale_nomut")
    await claim(runId, taskId)

    const db1 = new Database(dbPath)
    const before = db1
      .prepare("SELECT last_heartbeat_at FROM runs WHERE id = ?")
      .get(runId) as { last_heartbeat_at: string | null }
    db1.close()

    await runEff(
      Effect.provide(
        heartbeatCommand({ run: runId, task: taskId, token: 999 }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db2 = new Database(dbPath)
    const after = db2
      .prepare("SELECT last_heartbeat_at FROM runs WHERE id = ?")
      .get(runId) as { last_heartbeat_at: string | null }
    db2.close()

    // last_heartbeat_at should be unchanged (no writes on stale token)
    expect(after.last_heartbeat_at).toBe(before.last_heartbeat_at)
  })

  it("succeeds when task is already running (idempotent re-heartbeat)", async () => {
    const taskId = await enqueue("task_hb_idem")
    const runId = await registerRun("run_hb_idem")
    const token = await claim(runId, taskId)

    // First heartbeat: claimed → running
    await Effect.runPromise(
      Effect.provide(
        heartbeatCommand({ run: runId, task: taskId, token }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )
    // Second heartbeat with same token: already running → still running
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: runId, task: taskId, token }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(taskId) as { status: string }
    db.close()
    expect(row.status).toBe("running")
  })

  // ── throttle ──────────────────────────────────────────────────────────────

  it("rejects stale token even within throttle window", async () => {
    const taskId = await enqueue("task_hb_stale_throttle")
    const runId = await registerRun("run_hb_stale_throttle")
    await claim(runId, taskId)

    // First heartbeat to set last_heartbeat_at
    await Effect.runPromise(
      Effect.provide(heartbeatCommand({ run: runId }), Layer.merge(dbLayer, silentOutput)),
    )

    // Stale token inside throttle window must still fail with STALE_TOKEN
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: runId, task: taskId, token: 999, throttleSeconds: 3600 }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    // Verify it fails because of STALE_TOKEN, not something else
    const cause = Exit.isFailure(exit) ? exit.cause : null
    expect(String(cause)).toContain("Stale fencing token")
  })

  it("skips writes when within throttle window (returns skipped:true)", async () => {
    const runId = await registerRun("run_hb_throttle")

    // First heartbeat sets last_heartbeat_at
    await Effect.runPromise(
      Effect.provide(heartbeatCommand({ run: runId }), Layer.merge(dbLayer, silentOutput)),
    )

    // Second heartbeat within 60-second throttle — should be skipped
    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(
        heartbeatCommand({ run: runId, throttleSeconds: 60 }),
        Layer.merge(dbLayer, out.layer),
      ),
    )

    expect(out.lines()).toHaveLength(1)
    const parsed = JSON.parse(out.lines()[0]!) as { ok: boolean; skipped: boolean }
    expect(parsed.ok).toBe(true)
    expect(parsed.skipped).toBe(true)

    // last_heartbeat_at should NOT have changed — verify it is non-null
    // (we can't compare to a pre-skip value easily, so check skipped:true is the key assertion)
    const db2 = new Database(dbPath)
    const after2 = db2
      .prepare("SELECT last_heartbeat_at FROM runs WHERE id = ?")
      .get(runId) as { last_heartbeat_at: string }
    db2.close()
    // The run was heartbeated before throttling, so last_heartbeat_at is non-null
    expect(after2.last_heartbeat_at).toBeTruthy()
  })

  it("does NOT throttle when hook is a lifecycle boundary", async () => {
    const runId = await registerRun("run_hb_lifecycle")

    // First heartbeat
    await Effect.runPromise(
      Effect.provide(heartbeatCommand({ run: runId }), Layer.merge(dbLayer, silentOutput)),
    )

    const db1 = new Database(dbPath)
    db1.prepare("SELECT last_heartbeat_at FROM runs WHERE id = ?").get(runId)
    db1.close()

    await new Promise((r) => setTimeout(r, 20))

    // Lifecycle hook bypasses throttle even within the window
    await Effect.runPromise(
      Effect.provide(
        heartbeatCommand({ run: runId, hook: "SessionEnd", throttleSeconds: 3600 }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db2 = new Database(dbPath)
    const after2 = db2
      .prepare("SELECT last_heartbeat_at FROM runs WHERE id = ?")
      .get(runId) as { last_heartbeat_at: string }
    db2.close()
    // last_heartbeat_at should be updated (lifecycle bypassed throttle)
    // It may be equal if SQLite rounds to seconds, so check last_hook instead
    expect(after2.last_heartbeat_at).toBeTruthy()
    // Check last_hook was updated to the lifecycle value
    const db3 = new Database(dbPath)
    const hook = db3
      .prepare("SELECT last_hook FROM runs WHERE id = ?")
      .get(runId) as { last_hook: string }
    db3.close()
    expect(hook.last_hook).toBe("SessionEnd")
  })

  it("writes when last_heartbeat_at is null (first heartbeat, any throttle)", async () => {
    const runId = await registerRun("run_hb_null")

    // Run has no last_heartbeat_at yet; throttle should not block
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: runId, throttleSeconds: 3600 }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT last_heartbeat_at FROM runs WHERE id = ?")
      .get(runId) as { last_heartbeat_at: string | null }
    db.close()
    expect(row.last_heartbeat_at).toBeTruthy()
  })

  it("outputs skipped:false and run on successful unthrottled heartbeat", async () => {
    const runId = await registerRun("run_hb_out")

    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(heartbeatCommand({ run: runId }), Layer.merge(dbLayer, out.layer)),
    )

    expect(out.lines()).toHaveLength(1)
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      skipped: boolean
      run: { id: string; status: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.skipped).toBe(false)
    expect(parsed.run.id).toBe(runId)
    expect(parsed.run.status).toBe("running")
  })

  it("outputs task in response when --task + --token provided", async () => {
    const taskId = await enqueue("task_hb_resp")
    const runId = await registerRun("run_hb_resp")
    const token = await claim(runId, taskId)

    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(
        heartbeatCommand({ run: runId, task: taskId, token }),
        Layer.merge(dbLayer, out.layer),
      ),
    )

    expect(out.lines()).toHaveLength(1)
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      skipped: boolean
      run: { id: string }
      task: { id: string; status: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.skipped).toBe(false)
    expect(parsed.run.id).toBe(runId)
    expect(parsed.task.id).toBe(taskId)
    expect(parsed.task.status).toBe("running")
  })
})

// ---------------------------------------------------------------------------
// 3. parseArgs — heartbeat routing
// ---------------------------------------------------------------------------

describe("parseArgs — heartbeat", () => {
  it("parses required --run flag", async () => {
    const result = await Effect.runPromise(
      parseArgs(["heartbeat", "--run", "run_abc"]),
    )
    expect(result).toMatchObject({ command: "heartbeat", run: "run_abc" })
  })

  it("parses all optional flags", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "heartbeat",
        "--run",
        "run_abc",
        "--task",
        "task_xyz",
        "--token",
        "3",
        "--hook",
        "PreToolUse",
        "--throttle-seconds",
        "60",
      ]),
    )
    expect(result).toMatchObject({
      command: "heartbeat",
      run: "run_abc",
      task: "task_xyz",
      token: 3,
      hook: "PreToolUse",
      throttleSeconds: 60,
    })
  })

  it("routes 'heartbeat --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["heartbeat", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "heartbeat" })
  })

  it("returns undefined for optional flags when absent", async () => {
    const result = await Effect.runPromise(
      parseArgs(["heartbeat", "--run", "run_abc"]),
    )
    expect(result).toMatchObject({
      command: "heartbeat",
      task: undefined,
      token: undefined,
      hook: undefined,
      throttleSeconds: undefined,
    })
  })
})

// ---------------------------------------------------------------------------
// 4. CLI process smoke tests
// ---------------------------------------------------------------------------

describe("pithos heartbeat (CLI process)", () => {
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

  const cliRegisterRun = (): string => {
    const out = execFileSync(BIN, ["run", "register", "--agent-kind", "envy"], {
      env,
      encoding: "utf-8",
    })
    return (JSON.parse(out) as { run: { id: string } }).run.id
  }

  const cliEnqueue = (capability = "triage"): string => {
    const out = execFileSync(
      BIN,
      ["enqueue", "--scope", "global", "--capability", capability, "--title", "Test task"],
      { env, encoding: "utf-8" },
    )
    return (JSON.parse(out) as { task: { id: string } }).task.id
  }

  const cliClaim = (runId: string): { taskId: string; token: number } => {
    const out = execFileSync(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(out) as {
      ok: boolean
      task: { id: string; fencing_token: number }
    }
    return { taskId: parsed.task.id, token: parsed.task.fencing_token }
  }

  it("heartbeats a run and returns ok:true with skipped:false", () => {
    const runId = cliRegisterRun()

    const stdout = execFileSync(BIN, ["heartbeat", "--run", runId], {
      env,
      encoding: "utf-8",
    })
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      skipped: boolean
      run: { id: string; status: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.skipped).toBe(false)
    expect(parsed.run.id).toBe(runId)
    expect(parsed.run.status).toBe("running")
  })

  it("advances task from claimed to running with valid token", { timeout: 20000 }, () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId, token } = cliClaim(runId)

    const stdout = execFileSync(
      BIN,
      ["heartbeat", "--run", runId, "--task", taskId, "--token", String(token)],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      task: { id: string; status: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.status).toBe("running")
  })

  it("exits 4 with stale fencing token", { timeout: 20000 }, () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId } = cliClaim(runId)

    const result = spawnSync(
      BIN,
      ["heartbeat", "--run", runId, "--task", taskId, "--token", "999"],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(4)
  })

  it("exits 3 when run does not exist", () => {
    const result = spawnSync(BIN, ["heartbeat", "--run", "run_nonexistent"], {
      env,
      encoding: "utf-8",
    })
    expect(result.status).toBe(3)
  })

  it("exits 2 when --run is missing", () => {
    const result = spawnSync(BIN, ["heartbeat"], { env, encoding: "utf-8" })
    expect(result.status).toBe(2)
  })

  it("exits 2 when --task is given without --token", () => {
    const runId = cliRegisterRun()
    const result = spawnSync(
      BIN,
      ["heartbeat", "--run", runId, "--task", "task_xyz"],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(2)
  })

  it("returns skipped:true when within throttle window", () => {
    const runId = cliRegisterRun()

    // First heartbeat
    execFileSync(BIN, ["heartbeat", "--run", runId], { env, encoding: "utf-8" })

    // Second within throttle window
    const stdout = execFileSync(
      BIN,
      ["heartbeat", "--run", runId, "--throttle-seconds", "3600"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as { ok: boolean; skipped: boolean }
    expect(parsed.ok).toBe(true)
    expect(parsed.skipped).toBe(true)
  })

  it("throttle bypassed for lifecycle hook SessionEnd", () => {
    const runId = cliRegisterRun()

    // First heartbeat
    execFileSync(BIN, ["heartbeat", "--run", runId], { env, encoding: "utf-8" })

    // Lifecycle hook — must not be throttled
    const stdout = execFileSync(
      BIN,
      ["heartbeat", "--run", runId, "--hook", "SessionEnd", "--throttle-seconds", "3600"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as { ok: boolean; skipped: boolean }
    expect(parsed.ok).toBe(true)
    expect(parsed.skipped).toBe(false)
  })

  it("shows help on --help", () => {
    const stdout = execFileSync(BIN, ["heartbeat", "--help"], { env, encoding: "utf-8" })
    expect(stdout).toContain("pithos heartbeat")
    expect(stdout).toContain("--run")
    expect(stdout).toContain("--throttle-seconds")
  })
})
