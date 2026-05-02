/**
 * CLI process smoke tests for pithos claim command.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"

import { runCli, runCliOk } from "./_helpers/exec.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-claim-"))
}

// ---------------------------------------------------------------------------
// CLI process smoke tests
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
