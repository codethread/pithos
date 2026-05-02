/**
 * CLI process smoke tests for pithos sweep command.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"

import { runCli, runCliOk } from "./_helpers/exec.ts"

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-sweep-cli-"))
}

describe("pithos sweep (CLI process)", () => {
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

  // Helper: enqueue a task. Returns task id.
  const cliEnqueue = async (capability = "triage"): Promise<string> => {
    const out = await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", capability, "--title", "Test task"],
      env,
    )
    return (JSON.parse(out) as { task: { id: string } }).task.id
  }

  // Helper: register a run. Returns run id.
  const cliRegisterRun = async (): Promise<string> => {
    const out = await runCliOk(BIN, ["run", "register", "--agent-kind", "envy"], env)
    return (JSON.parse(out) as { run: { id: string } }).run.id
  }

  // Helper: claim a task. Returns fencing token.
  const cliClaim = async (runId: string): Promise<number> => {
    const out = await runCliOk(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage"],
      env,
    )
    return (JSON.parse(out) as { task: { fencing_token: number } }).task.fencing_token
  }

  // Helper: expire a task's lease via direct DB write.
  const expireLease = (taskId: string): void => {
    const db = new Database(dbPath)
    db.prepare(
      `UPDATE tasks
       SET lease_until = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-60 seconds'))
       WHERE id = ?`,
    ).run(taskId)
    db.close()
  }

  // -------------------------------------------------------------------------
  // Basic invocation
  // -------------------------------------------------------------------------

  it("exits 0 with ok:true JSON when there is nothing to sweep", async () => {
    const stdout = await runCliOk(BIN, ["sweep"], env)
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      requeued: number
      dead_lettered: number
      stale_runs: number
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.requeued).toBe(0)
    expect(parsed.dead_lettered).toBe(0)
    expect(parsed.stale_runs).toBe(0)
  })

  it("requeues an expired claimed task", async () => {
    const taskId = await cliEnqueue()
    const runId = await cliRegisterRun()
    await cliClaim(runId)
    expireLease(taskId)

    const stdout = await runCliOk(BIN, ["sweep"], env)
    const parsed = JSON.parse(stdout) as { ok: boolean; requeued: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.requeued).toBe(1)

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(taskId) as { status: string }
    db.close()
    expect(row.status).toBe("queued")
  })

  it("dead-letters an expired task when max_attempts reached", async () => {
    const taskId = await cliEnqueue()
    const runId = await cliRegisterRun()
    await cliClaim(runId)

    // Force max_attempts = 1 so one attempt exhausts the budget.
    const db = new Database(dbPath)
    db.prepare("UPDATE tasks SET max_attempts = 1 WHERE id = ?").run(taskId)
    db.close()

    expireLease(taskId)

    const stdout = await runCliOk(BIN, ["sweep"], env)
    const parsed = JSON.parse(stdout) as { ok: boolean; dead_lettered: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.dead_lettered).toBe(1)

    const db2 = new Database(dbPath)
    const row = db2
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(taskId) as { status: string }
    db2.close()
    expect(row.status).toBe("dead_letter")
  })

  it("respects --lease-grace-seconds flag", async () => {
    const taskId = await cliEnqueue()
    const runId = await cliRegisterRun()
    await cliClaim(runId)
    // Expire lease by only 5 seconds.
    const db = new Database(dbPath)
    db.prepare(
      `UPDATE tasks
       SET lease_until = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-5 seconds'))
       WHERE id = ?`,
    ).run(taskId)
    db.close()

    // 30-second grace — task should NOT be requeued.
    const stdout = await runCliOk(BIN, ["sweep", "--lease-grace-seconds", "30"], env)
    const parsed = JSON.parse(stdout) as { ok: boolean; requeued: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.requeued).toBe(0)

    const db2 = new Database(dbPath)
    const row = db2
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(taskId) as { status: string }
    db2.close()
    expect(row.status).toBe("claimed")
  })

  it("exits 2 when --lease-grace-seconds is not a valid integer", async () => {
    const result = await runCli(BIN, ["sweep", "--lease-grace-seconds", "abc"], env)
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --run-stale-minutes is not a valid integer", async () => {
    const result = await runCli(BIN, ["sweep", "--run-stale-minutes", "xyz"], env)
    expect(result.exitCode).toBe(2)
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["sweep", "--help"], env)
    expect(stdout).toContain("pithos sweep")
    expect(stdout).toContain("--lease-grace-seconds")
    expect(stdout).toContain("--run-stale-minutes")
  })

  it("is idempotent — sweeping an already-clean DB twice yields zeros", async () => {
    await runCliOk(BIN, ["sweep"], env)
    const stdout = await runCliOk(BIN, ["sweep"], env)
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      requeued: number
      dead_lettered: number
      stale_runs: number
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.requeued).toBe(0)
    expect(parsed.dead_lettered).toBe(0)
    expect(parsed.stale_runs).toBe(0)
  })
})
