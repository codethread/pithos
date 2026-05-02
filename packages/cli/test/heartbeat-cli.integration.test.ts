/**
 * CLI process smoke tests for pithos heartbeat command.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runCli, runCliOk } from "./_helpers/exec.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-hb-"))
}

// ---------------------------------------------------------------------------
// CLI process smoke tests
// ---------------------------------------------------------------------------

describe("pithos heartbeat (CLI process)", () => {
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

  const cliRegisterRun = async (): Promise<string> => {
    const out = await runCliOk(BIN, ["run", "register", "--agent-kind", "envy"], env)
    return (JSON.parse(out) as { run: { id: string } }).run.id
  }

  const cliEnqueue = async (capability = "triage"): Promise<string> => {
    const out = await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", capability, "--title", "Test task"],
      env,
    )
    return (JSON.parse(out) as { task: { id: string } }).task.id
  }

  const cliClaim = async (runId: string): Promise<{ taskId: string; token: number }> => {
    const out = await runCliOk(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage"],
      env,
    )
    const parsed = JSON.parse(out) as {
      ok: boolean
      task: { id: string; fencing_token: number }
    }
    return { taskId: parsed.task.id, token: parsed.task.fencing_token }
  }

  it("heartbeats a run and returns ok:true with skipped:false", async () => {
    const runId = await cliRegisterRun()

    const stdout = await runCliOk(BIN, ["heartbeat", "--run", runId], env)
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

  it("advances task from claimed to running with valid token", { timeout: 20000 }, async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId, token } = await cliClaim(runId)

    const stdout = await runCliOk(
      BIN,
      ["heartbeat", "--run", runId, "--task", taskId, "--token", String(token)],
      env,
    )
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      task: { id: string; status: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.status).toBe("running")
  })

  it("exits 4 with stale fencing token", { timeout: 20000 }, async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId } = await cliClaim(runId)

    const result = await runCli(
      BIN,
      ["heartbeat", "--run", runId, "--task", taskId, "--token", "999"],
      env,
    )
    expect(result.exitCode).toBe(4)
  })

  it("exits 3 when run does not exist", async () => {
    const result = await runCli(BIN, ["heartbeat", "--run", "run_nonexistent"], env)
    expect(result.exitCode).toBe(3)
  })

  it("exits 2 when --run is missing", async () => {
    const result = await runCli(BIN, ["heartbeat"], env)
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --task is given without --token", async () => {
    const runId = await cliRegisterRun()
    const result = await runCli(
      BIN,
      ["heartbeat", "--run", runId, "--task", "task_xyz"],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("returns skipped:true when within throttle window", async () => {
    const runId = await cliRegisterRun()

    // First heartbeat
    await runCliOk(BIN, ["heartbeat", "--run", runId], env)

    // Second within throttle window
    const stdout = await runCliOk(
      BIN,
      ["heartbeat", "--run", runId, "--throttle-seconds", "3600"],
      env,
    )
    const parsed = JSON.parse(stdout) as { ok: boolean; skipped: boolean }
    expect(parsed.ok).toBe(true)
    expect(parsed.skipped).toBe(true)
  })

  it("throttle bypassed for lifecycle hook SessionEnd", async () => {
    const runId = await cliRegisterRun()

    // First heartbeat
    await runCliOk(BIN, ["heartbeat", "--run", runId], env)

    // Lifecycle hook — must not be throttled
    const stdout = await runCliOk(
      BIN,
      ["heartbeat", "--run", runId, "--hook", "SessionEnd", "--throttle-seconds", "3600"],
      env,
    )
    const parsed = JSON.parse(stdout) as { ok: boolean; skipped: boolean }
    expect(parsed.ok).toBe(true)
    expect(parsed.skipped).toBe(false)
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["heartbeat", "--help"], env)
    expect(stdout).toContain("pithos heartbeat")
    expect(stdout).toContain("--run")
    expect(stdout).toContain("--throttle-seconds")
  })
})
