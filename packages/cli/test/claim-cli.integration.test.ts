/**
 * CLI process smoke tests for pithos claim — cross-process atomicity only.
 *
 * All other claim behaviour (validation, DB state, event writes, FIFO ordering,
 * output format, error codes, help output) is covered by unit tests
 * (src/commands/claim.test.ts) and SQLite integration tests
 * (test/claim-sqlite.integration.test.ts), which import the command module
 * directly.
 *
 * The two tests below exercise true multi-process contention against the same
 * SQLite file — something that cannot be simulated in-process because
 * better-sqlite3 is synchronous/single-threaded.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"

import { runCli, runCliOk } from "./_helpers/exec.ts"

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-claim-race-"))
}

describe("pithos claim (CLI process — cross-process races)", () => {
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

  it("RACE: two concurrent processes — only one claims the task", async () => {
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

  it("RACE: two runs, two tasks — each gets exactly one", async () => {
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
