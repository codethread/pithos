/**
 * Tests for Slice 10: Complete or fail a claimed task safely.
 *
 * Layers:
 *  1. Unit  — validation with fake DB service
 *  2. Integration — real SQLite in temp dir
 *  3. parseArgs  — complete/fail routing
 *  4. CLI process — smoke tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync, spawnSync } from "node:child_process"
import Database from "better-sqlite3"

import { completeCommand } from "../src/commands/complete.ts"
import { failCommand } from "../src/commands/fail.ts"
import { claimCommand } from "../src/commands/claim.ts"
import { enqueueCommand } from "../src/commands/enqueue.ts"
import { runRegisterCommand } from "../src/commands/run.ts"
import { parseArgs } from "../src/cli/args.ts"
import { makeDbServiceLive, makeDbServiceTest } from "../src/layers/db.ts"
import { makeIdServiceTest } from "../src/layers/ids.ts"
import { FsServiceLive, makeFsServiceTest } from "../src/layers/fs.ts"
import { initCommand } from "../src/commands/init.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-complete-"))
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / validation only
// ---------------------------------------------------------------------------

describe("completeCommand (unit — fake DB)", () => {
  const fakeLayer = Layer.mergeAll(makeDbServiceTest(), makeFsServiceTest())

  it("fails VALIDATION_ERROR when task id is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId: undefined, run: "run_abc", token: 1 }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --run is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId: "task_abc", run: undefined, token: 1 }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --token is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId: "task_abc", run: "run_abc", token: undefined }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --token is NaN", async () => {
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId: "task_abc", run: "run_abc", token: NaN }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --result-file is not valid JSON", async () => {
    const fs = makeFsServiceTest(new Map([["/tmp/bad.json", "not json {"]]))
    const layer = Layer.mergeAll(makeDbServiceTest(), fs)
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId: "task_abc", run: "run_abc", token: 1, resultFile: "/tmp/bad.json" }),
        layer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("failCommand (unit — fake DB)", () => {
  it("fails VALIDATION_ERROR when task id is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        failCommand({ taskId: undefined, run: "run_abc", token: 1 }),
        makeDbServiceTest(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --run is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        failCommand({ taskId: "task_abc", run: undefined, token: 1 }),
        makeDbServiceTest(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --token is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        failCommand({ taskId: "task_abc", run: "run_abc", token: undefined }),
        makeDbServiceTest(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --token is NaN", async () => {
    const exit = await runEff(
      Effect.provide(
        failCommand({ taskId: "task_abc", run: "run_abc", token: NaN }),
        makeDbServiceTest(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Integration — real SQLite
// ---------------------------------------------------------------------------

describe("completeCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    dbLayer = makeDbServiceLive(dbPath)
    await Effect.runPromise(Effect.provide(initCommand, dbLayer))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const enqueue = async (taskId: string): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([taskId]), FsServiceLive)
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: `Task ${taskId}` }),
        layer,
      ),
    )
    return taskId
  }

  const registerRun = async (runId: string): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([runId]), FsServiceLive)
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: runId }), layer),
    )
    return runId
  }

  const claimTask = async (runId: string): Promise<{ taskId: string; token: number }> => {
    await Effect.runPromise(
      Effect.provide(
        claimCommand({ run: runId, scope: "global", capability: "triage" }),
        dbLayer,
      ),
    )
    const db = new Database(dbPath)
    const row = db
      .prepare(
        "SELECT id, fencing_token FROM tasks WHERE lease_owner_run_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(runId) as { id: string; fencing_token: number }
    db.close()
    return { taskId: row.id, token: row.fencing_token }
  }

  it("completes a claimed task and sets status to done", async () => {
    await enqueue("task_complete1")
    await registerRun("run_complete1")
    const { taskId, token } = await claimTask("run_complete1")

    await Effect.runPromise(
      Effect.provide(
        completeCommand({ taskId, run: "run_complete1", token }),
        Layer.mergeAll(dbLayer, FsServiceLive),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT status, completed_at FROM tasks WHERE id = ?")
      .get(taskId) as { status: string; completed_at: string | null }
    db.close()

    expect(row.status).toBe("done")
    expect(row.completed_at).toBeTruthy()
  })

  it("completes a running task (heartbeat-advanced) and sets status to done", async () => {
    await enqueue("task_complete_running")
    await registerRun("run_complete_running")
    const { taskId, token } = await claimTask("run_complete_running")

    // Advance to running via heartbeat directly in DB
    const db0 = new Database(dbPath)
    db0.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(taskId)
    db0.close()

    await Effect.runPromise(
      Effect.provide(
        completeCommand({ taskId, run: "run_complete_running", token }),
        Layer.mergeAll(dbLayer, FsServiceLive),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT status, completed_at FROM tasks WHERE id = ?")
      .get(taskId) as { status: string; completed_at: string | null }
    db.close()

    expect(row.status).toBe("done")
    expect(row.completed_at).toBeTruthy()
  })

  it("stores result_json from --result-file", async () => {
    await enqueue("task_complete_res")
    await registerRun("run_complete_res")
    const { taskId, token } = await claimTask("run_complete_res")

    const resultPath = join(tempDir, "result.json")
    const resultData = { outcome: "success", lines: 42 }
    writeFileSync(resultPath, JSON.stringify(resultData))

    await Effect.runPromise(
      Effect.provide(
        completeCommand({ taskId, run: "run_complete_res", token, resultFile: resultPath }),
        Layer.mergeAll(dbLayer, FsServiceLive),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT result_json FROM tasks WHERE id = ?")
      .get(taskId) as { result_json: string }
    db.close()

    const parsed = JSON.parse(row.result_json) as typeof resultData
    expect(parsed.outcome).toBe("success")
    expect(parsed.lines).toBe(42)
  })

  it("appends a task.completed event", async () => {
    await enqueue("task_complete_ev")
    await registerRun("run_complete_ev")
    const { taskId, token } = await claimTask("run_complete_ev")

    await Effect.runPromise(
      Effect.provide(
        completeCommand({ taskId, run: "run_complete_ev", token }),
        Layer.mergeAll(dbLayer, FsServiceLive),
      ),
    )

    const db = new Database(dbPath)
    const event = db
      .prepare(
        "SELECT type, actor_run_id, payload_json FROM events WHERE type = 'task.completed'",
      )
      .get() as { type: string; actor_run_id: string; payload_json: string }
    db.close()

    expect(event.type).toBe("task.completed")
    expect(event.actor_run_id).toBe("run_complete_ev")
    const payload = JSON.parse(event.payload_json) as { run_id: string; fencing_token: number }
    expect(payload.run_id).toBe("run_complete_ev")
    expect(payload.fencing_token).toBe(token)
  })

  it("outputs ok:true and full task row on success", async () => {
    await enqueue("task_complete_out")
    await registerRun("run_complete_out")
    const { taskId, token } = await claimTask("run_complete_out")

    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
    try {
      await Effect.runPromise(
        Effect.provide(
          completeCommand({ taskId, run: "run_complete_out", token }),
          Layer.mergeAll(dbLayer, FsServiceLive),
        ),
      )
    } finally {
      console.log = originalLog
    }

    expect(logs).toHaveLength(1)
    const parsed = JSON.parse(logs[0]!) as {
      ok: boolean
      task: { id: string; status: string; completed_at: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.status).toBe("done")
    expect(parsed.task.completed_at).toBeTruthy()
  })

  it("fails STALE_TOKEN when fencing token is wrong", async () => {
    await enqueue("task_complete_stale")
    await registerRun("run_complete_stale")
    const { taskId } = await claimTask("run_complete_stale")

    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId, run: "run_complete_stale", token: 999 }),
        Layer.mergeAll(dbLayer, FsServiceLive),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)

    // Verify task is still claimed (not done)
    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(taskId) as { status: string }
    db.close()
    expect(row.status).toBe("claimed")
  })

  it("fails STALE_TOKEN when run is wrong owner", async () => {
    await enqueue("task_complete_wrongrun")
    await registerRun("run_complete_wr_a")
    await registerRun("run_complete_wr_b")
    const { taskId, token } = await claimTask("run_complete_wr_a")

    // run_b tries to complete but doesn't own the task
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId, run: "run_complete_wr_b", token }),
        Layer.mergeAll(dbLayer, FsServiceLive),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails STALE_TOKEN when task is already done", async () => {
    await enqueue("task_complete_done")
    await registerRun("run_complete_done")
    const { taskId, token } = await claimTask("run_complete_done")

    // Complete once
    await Effect.runPromise(
      Effect.provide(
        completeCommand({ taskId, run: "run_complete_done", token }),
        Layer.mergeAll(dbLayer, FsServiceLive),
      ),
    )

    // Try to complete again — should fail
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId, run: "run_complete_done", token }),
        Layer.mergeAll(dbLayer, FsServiceLive),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("failCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    dbLayer = makeDbServiceLive(dbPath)
    await Effect.runPromise(Effect.provide(initCommand, dbLayer))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const enqueue = async (taskId: string): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([taskId]), FsServiceLive)
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: `Task ${taskId}` }),
        layer,
      ),
    )
    return taskId
  }

  const registerRun = async (runId: string): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([runId]), FsServiceLive)
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: runId }), layer),
    )
    return runId
  }

  const claimTask = async (runId: string): Promise<{ taskId: string; token: number }> => {
    await Effect.runPromise(
      Effect.provide(
        claimCommand({ run: runId, scope: "global", capability: "triage" }),
        dbLayer,
      ),
    )
    const db = new Database(dbPath)
    const row = db
      .prepare(
        "SELECT id, fencing_token FROM tasks WHERE lease_owner_run_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(runId) as { id: string; fencing_token: number }
    db.close()
    return { taskId: row.id, token: row.fencing_token }
  }

  it("fails a claimed task and sets status to failed", async () => {
    await enqueue("task_fail1")
    await registerRun("run_fail1")
    const { taskId, token } = await claimTask("run_fail1")

    await Effect.runPromise(
      Effect.provide(
        failCommand({ taskId, run: "run_fail1", token, reason: "worker crashed" }),
        dbLayer,
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT status, result_json FROM tasks WHERE id = ?")
      .get(taskId) as { status: string; result_json: string }
    db.close()

    expect(row.status).toBe("failed")
    const result = JSON.parse(row.result_json) as { reason: string }
    expect(result.reason).toBe("worker crashed")
  })

  it("stores empty reason when --reason is omitted", async () => {
    await enqueue("task_fail_noreason")
    await registerRun("run_fail_noreason")
    const { taskId, token } = await claimTask("run_fail_noreason")

    await Effect.runPromise(
      Effect.provide(
        failCommand({ taskId, run: "run_fail_noreason", token }),
        dbLayer,
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT result_json FROM tasks WHERE id = ?")
      .get(taskId) as { result_json: string }
    db.close()

    const result = JSON.parse(row.result_json) as { reason: string }
    expect(result.reason).toBe("")
  })

  it("appends a task.failed event", async () => {
    await enqueue("task_fail_ev")
    await registerRun("run_fail_ev")
    const { taskId, token } = await claimTask("run_fail_ev")

    await Effect.runPromise(
      Effect.provide(
        failCommand({ taskId, run: "run_fail_ev", token, reason: "timeout" }),
        dbLayer,
      ),
    )

    const db = new Database(dbPath)
    const event = db
      .prepare(
        "SELECT type, actor_run_id, payload_json FROM events WHERE type = 'task.failed'",
      )
      .get() as { type: string; actor_run_id: string; payload_json: string }
    db.close()

    expect(event.type).toBe("task.failed")
    expect(event.actor_run_id).toBe("run_fail_ev")
    const payload = JSON.parse(event.payload_json) as {
      run_id: string
      fencing_token: number
      reason: string
    }
    expect(payload.run_id).toBe("run_fail_ev")
    expect(payload.reason).toBe("timeout")
  })

  it("outputs ok:true and full task row on success", async () => {
    await enqueue("task_fail_out")
    await registerRun("run_fail_out")
    const { taskId, token } = await claimTask("run_fail_out")

    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
    try {
      await Effect.runPromise(
        Effect.provide(
          failCommand({ taskId, run: "run_fail_out", token, reason: "oops" }),
          dbLayer,
        ),
      )
    } finally {
      console.log = originalLog
    }

    expect(logs).toHaveLength(1)
    const parsed = JSON.parse(logs[0]!) as {
      ok: boolean
      task: { id: string; status: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.status).toBe("failed")
  })

  it("fails STALE_TOKEN when fencing token is wrong", async () => {
    await enqueue("task_fail_stale")
    await registerRun("run_fail_stale")
    const { taskId } = await claimTask("run_fail_stale")

    const exit = await runEff(
      Effect.provide(
        failCommand({ taskId, run: "run_fail_stale", token: 999 }),
        dbLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)

    // Task should still be claimed
    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(taskId) as { status: string }
    db.close()
    expect(row.status).toBe("claimed")
  })

  it("fails STALE_TOKEN when task is already done", async () => {
    await enqueue("task_fail_done")
    await registerRun("run_fail_done_r")
    const { taskId, token } = await claimTask("run_fail_done_r")

    // First complete the task
    await Effect.runPromise(
      Effect.provide(
        failCommand({ taskId, run: "run_fail_done_r", token }),
        dbLayer,
      ),
    )

    // Try to fail again — should fail
    const exit = await runEff(
      Effect.provide(
        failCommand({ taskId, run: "run_fail_done_r", token }),
        dbLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. parseArgs — complete/fail routing
// ---------------------------------------------------------------------------

describe("parseArgs — complete", () => {
  it("parses required flags", async () => {
    const result = await Effect.runPromise(
      parseArgs(["complete", "task_abc", "--run", "run_xyz", "--token", "1"]),
    )
    expect(result).toMatchObject({
      command: "complete",
      taskId: "task_abc",
      run: "run_xyz",
      token: 1,
      resultFile: undefined,
    })
  })

  it("parses --result-file flag", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "complete",
        "task_abc",
        "--run",
        "run_xyz",
        "--token",
        "2",
        "--result-file",
        "/tmp/res.json",
      ]),
    )
    expect(result).toMatchObject({
      command: "complete",
      taskId: "task_abc",
      token: 2,
      resultFile: "/tmp/res.json",
    })
  })

  it("routes 'complete --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["complete", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "complete" })
  })

  it("parses --token as a number", async () => {
    const result = await Effect.runPromise(
      parseArgs(["complete", "task_abc", "--run", "run_xyz", "--token", "42"]),
    )
    expect(result).toMatchObject({ command: "complete", token: 42 })
  })
})

describe("parseArgs — fail", () => {
  it("parses required flags", async () => {
    const result = await Effect.runPromise(
      parseArgs(["fail", "task_abc", "--run", "run_xyz", "--token", "1"]),
    )
    expect(result).toMatchObject({
      command: "fail",
      taskId: "task_abc",
      run: "run_xyz",
      token: 1,
      reason: undefined,
    })
  })

  it("parses --reason flag", async () => {
    const result = await Effect.runPromise(
      parseArgs(["fail", "task_abc", "--run", "run_xyz", "--token", "1", "--reason", "timeout"]),
    )
    expect(result).toMatchObject({
      command: "fail",
      taskId: "task_abc",
      reason: "timeout",
    })
  })

  it("routes 'fail --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["fail", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "fail" })
  })
})

// ---------------------------------------------------------------------------
// 4. CLI process smoke tests
// ---------------------------------------------------------------------------

describe("pithos complete (CLI process)", () => {
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

  const cliEnqueue = (): string => {
    const out = execFileSync(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "Test task"],
      { env, encoding: "utf-8" },
    )
    return (JSON.parse(out) as { task: { id: string } }).task.id
  }

  const cliRegisterRun = (): string => {
    const out = execFileSync(BIN, ["run", "register", "--agent-kind", "envy"], {
      env,
      encoding: "utf-8",
    })
    return (JSON.parse(out) as { run: { id: string } }).run.id
  }

  const cliClaim = (runId: string): { taskId: string; token: number } => {
    const out = execFileSync(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(out) as { ok: boolean; task: { id: string; fencing_token: number } }
    return { taskId: parsed.task.id, token: parsed.task.fencing_token }
  }

  it("completes a task and returns ok:true with status done", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId, token } = cliClaim(runId)

    const stdout = execFileSync(
      BIN,
      ["complete", taskId, "--run", runId, "--token", String(token)],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      task: { id: string; status: string; completed_at: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toBe(taskId)
    expect(parsed.task.status).toBe("done")
    expect(parsed.task.completed_at).toBeTruthy()
  })

  it("stores result_json from --result-file", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId, token } = cliClaim(runId)

    const resultPath = join(tempDir, "result.json")
    const resultData = { score: 99, label: "pass" }
    writeFileSync(resultPath, JSON.stringify(resultData))

    const stdout = execFileSync(
      BIN,
      ["complete", taskId, "--run", runId, "--token", String(token), "--result-file", resultPath],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      task: { result_json: string }
    }
    expect(parsed.ok).toBe(true)
    const result = JSON.parse(parsed.task.result_json) as typeof resultData
    expect(result.score).toBe(99)
  })

  it("exits 4 with stale fencing token", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId } = cliClaim(runId)

    const result = spawnSync(
      BIN,
      ["complete", taskId, "--run", runId, "--token", "999"],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(4)
  })

  it("exits 4 when token is correct but wrong run owns the task", () => {
    cliEnqueue()
    const runA = cliRegisterRun()
    const runB = cliRegisterRun()
    const { taskId, token } = cliClaim(runA)

    const result = spawnSync(
      BIN,
      ["complete", taskId, "--run", runB, "--token", String(token)],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(4)
  })

  it("exits 2 when task id is missing", () => {
    const runId = cliRegisterRun()
    const result = spawnSync(
      BIN,
      ["complete", "--run", runId, "--token", "1"],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(2)
  })

  it("exits 2 when --run is missing", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId, token } = cliClaim(runId)
    const result = spawnSync(
      BIN,
      ["complete", taskId, "--token", String(token)],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(2)
  })

  it("exits 2 when --token is missing", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId } = cliClaim(runId)
    const result = spawnSync(
      BIN,
      ["complete", taskId, "--run", runId],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(2)
  })

  it("shows help on --help", () => {
    const stdout = execFileSync(BIN, ["complete", "--help"], { env, encoding: "utf-8" })
    expect(stdout).toContain("pithos complete")
    expect(stdout).toContain("--run")
    expect(stdout).toContain("--token")
    expect(stdout).toContain("--result-file")
  })

  it("exits 4 when completing an already-completed task", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId, token } = cliClaim(runId)

    // First completion — success
    execFileSync(BIN, ["complete", taskId, "--run", runId, "--token", String(token)], {
      env,
      encoding: "utf-8",
    })

    // Second completion — stale
    const result = spawnSync(
      BIN,
      ["complete", taskId, "--run", runId, "--token", String(token)],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(4)
  })
})

describe("pithos fail (CLI process)", () => {
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

  const cliEnqueue = (): string => {
    const out = execFileSync(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "Test task"],
      { env, encoding: "utf-8" },
    )
    return (JSON.parse(out) as { task: { id: string } }).task.id
  }

  const cliRegisterRun = (): string => {
    const out = execFileSync(BIN, ["run", "register", "--agent-kind", "envy"], {
      env,
      encoding: "utf-8",
    })
    return (JSON.parse(out) as { run: { id: string } }).run.id
  }

  const cliClaim = (runId: string): { taskId: string; token: number } => {
    const out = execFileSync(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(out) as { ok: boolean; task: { id: string; fencing_token: number } }
    return { taskId: parsed.task.id, token: parsed.task.fencing_token }
  }

  it("fails a task and returns ok:true with status failed", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId, token } = cliClaim(runId)

    const stdout = execFileSync(
      BIN,
      ["fail", taskId, "--run", runId, "--token", String(token), "--reason", "worker crashed"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      task: { id: string; status: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toBe(taskId)
    expect(parsed.task.status).toBe("failed")
  })

  it("stores reason in result_json", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId, token } = cliClaim(runId)

    const stdout = execFileSync(
      BIN,
      ["fail", taskId, "--run", runId, "--token", String(token), "--reason", "timeout occurred"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as { ok: boolean; task: { result_json: string } }
    const result = JSON.parse(parsed.task.result_json) as { reason: string }
    expect(result.reason).toBe("timeout occurred")
  })

  it("exits 4 with stale fencing token", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId } = cliClaim(runId)

    const result = spawnSync(
      BIN,
      ["fail", taskId, "--run", runId, "--token", "999"],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(4)
  })

  it("exits 2 when task id is missing", () => {
    const runId = cliRegisterRun()
    const result = spawnSync(BIN, ["fail", "--run", runId, "--token", "1"], {
      env,
      encoding: "utf-8",
    })
    expect(result.status).toBe(2)
  })

  it("exits 2 when --run is missing", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId, token } = cliClaim(runId)
    const result = spawnSync(BIN, ["fail", taskId, "--token", String(token)], {
      env,
      encoding: "utf-8",
    })
    expect(result.status).toBe(2)
  })

  it("exits 2 when --token is missing", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId } = cliClaim(runId)
    const result = spawnSync(BIN, ["fail", taskId, "--run", runId], { env, encoding: "utf-8" })
    expect(result.status).toBe(2)
  })

  it("shows help on --help", () => {
    const stdout = execFileSync(BIN, ["fail", "--help"], { env, encoding: "utf-8" })
    expect(stdout).toContain("pithos fail")
    expect(stdout).toContain("--run")
    expect(stdout).toContain("--token")
    expect(stdout).toContain("--reason")
  })

  it("exits 4 when failing an already-failed task", () => {
    cliEnqueue()
    const runId = cliRegisterRun()
    const { taskId, token } = cliClaim(runId)

    // First fail — success
    execFileSync(BIN, ["fail", taskId, "--run", runId, "--token", String(token)], {
      env,
      encoding: "utf-8",
    })

    // Second fail — stale
    const result = spawnSync(BIN, ["fail", taskId, "--run", runId, "--token", String(token)], {
      env,
      encoding: "utf-8",
    })
    expect(result.status).toBe(4)
  })
})
