/**
 * CLI process smoke tests for pithos complete and fail commands.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runCli, runCliOk } from "./_helpers/exec.ts"

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-complete-"))
}

describe("pithos complete (CLI process)", () => {
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

  const cliEnqueue = async (): Promise<string> => {
    const out = await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "Test task"],
      env,
    )
    return (JSON.parse(out) as { task: { id: string } }).task.id
  }

  const cliRegisterRun = async (): Promise<string> => {
    const out = await runCliOk(BIN, ["run", "register", "--agent-kind", "envy"], env)
    return (JSON.parse(out) as { run: { id: string } }).run.id
  }

  const cliClaim = async (runId: string): Promise<{ taskId: string; token: number }> => {
    const out = await runCliOk(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage"],
      env,
    )
    const parsed = JSON.parse(out) as { ok: boolean; task: { id: string; fencing_token: number } }
    return { taskId: parsed.task.id, token: parsed.task.fencing_token }
  }

  it("completes a task and returns ok:true with status done", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId, token } = await cliClaim(runId)

    const stdout = await runCliOk(
      BIN,
      ["complete", taskId, "--run", runId, "--token", String(token)],
      env,
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

  it("stores result_json from --result-file", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId, token } = await cliClaim(runId)

    const resultPath = join(tempDir, "result.json")
    const resultData = { score: 99, label: "pass" }
    writeFileSync(resultPath, JSON.stringify(resultData))

    const stdout = await runCliOk(
      BIN,
      ["complete", taskId, "--run", runId, "--token", String(token), "--result-file", resultPath],
      env,
    )
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      task: { result_json: string }
    }
    expect(parsed.ok).toBe(true)
    const result = JSON.parse(parsed.task.result_json) as typeof resultData
    expect(result.score).toBe(99)
  })

  it("exits 4 with stale fencing token", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId } = await cliClaim(runId)

    const result = await runCli(
      BIN,
      ["complete", taskId, "--run", runId, "--token", "999"],
      env,
    )
    expect(result.exitCode).toBe(4)
  })

  it("exits 4 when token is correct but wrong run owns the task", async () => {
    await cliEnqueue()
    const runA = await cliRegisterRun()
    const runB = await cliRegisterRun()
    const { taskId, token } = await cliClaim(runA)

    const result = await runCli(
      BIN,
      ["complete", taskId, "--run", runB, "--token", String(token)],
      env,
    )
    expect(result.exitCode).toBe(4)
  })

  it("exits 2 when task id is missing", async () => {
    const runId = await cliRegisterRun()
    const result = await runCli(
      BIN,
      ["complete", "--run", runId, "--token", "1"],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --run is missing", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId, token } = await cliClaim(runId)
    const result = await runCli(
      BIN,
      ["complete", taskId, "--token", String(token)],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --token is missing", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId } = await cliClaim(runId)
    const result = await runCli(
      BIN,
      ["complete", taskId, "--run", runId],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["complete", "--help"], env)
    expect(stdout).toContain("pithos complete")
    expect(stdout).toContain("--run")
    expect(stdout).toContain("--token")
    expect(stdout).toContain("--result-file")
  })

  it("exits 4 when completing an already-completed task", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId, token } = await cliClaim(runId)

    // First completion — success
    await runCliOk(BIN, ["complete", taskId, "--run", runId, "--token", String(token)], env)

    // Second completion — stale
    const result = await runCli(
      BIN,
      ["complete", taskId, "--run", runId, "--token", String(token)],
      env,
    )
    expect(result.exitCode).toBe(4)
  })
})

describe("pithos fail (CLI process)", () => {
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

  const cliEnqueue = async (): Promise<string> => {
    const out = await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "Test task"],
      env,
    )
    return (JSON.parse(out) as { task: { id: string } }).task.id
  }

  const cliRegisterRun = async (): Promise<string> => {
    const out = await runCliOk(BIN, ["run", "register", "--agent-kind", "envy"], env)
    return (JSON.parse(out) as { run: { id: string } }).run.id
  }

  const cliClaim = async (runId: string): Promise<{ taskId: string; token: number }> => {
    const out = await runCliOk(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage"],
      env,
    )
    const parsed = JSON.parse(out) as { ok: boolean; task: { id: string; fencing_token: number } }
    return { taskId: parsed.task.id, token: parsed.task.fencing_token }
  }

  it("fails a task and returns ok:true with status failed", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId, token } = await cliClaim(runId)

    const stdout = await runCliOk(
      BIN,
      ["fail", taskId, "--run", runId, "--token", String(token), "--reason", "worker crashed"],
      env,
    )
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      task: { id: string; status: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toBe(taskId)
    expect(parsed.task.status).toBe("failed")
  })

  it("stores reason in result_json", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId, token } = await cliClaim(runId)

    const stdout = await runCliOk(
      BIN,
      ["fail", taskId, "--run", runId, "--token", String(token), "--reason", "timeout occurred"],
      env,
    )
    const parsed = JSON.parse(stdout) as { ok: boolean; task: { result_json: string } }
    const result = JSON.parse(parsed.task.result_json) as { reason: string }
    expect(result.reason).toBe("timeout occurred")
  })

  it("exits 4 with stale fencing token", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId } = await cliClaim(runId)

    const result = await runCli(
      BIN,
      ["fail", taskId, "--run", runId, "--token", "999"],
      env,
    )
    expect(result.exitCode).toBe(4)
  })

  it("exits 2 when task id is missing", async () => {
    const runId = await cliRegisterRun()
    const result = await runCli(BIN, ["fail", "--run", runId, "--token", "1"], env)
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --run is missing", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId, token } = await cliClaim(runId)
    const result = await runCli(BIN, ["fail", taskId, "--token", String(token)], env)
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --token is missing", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId } = await cliClaim(runId)
    const result = await runCli(BIN, ["fail", taskId, "--run", runId], env)
    expect(result.exitCode).toBe(2)
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["fail", "--help"], env)
    expect(stdout).toContain("pithos fail")
    expect(stdout).toContain("--run")
    expect(stdout).toContain("--token")
    expect(stdout).toContain("--reason")
  })

  it("exits 4 when failing an already-failed task", async () => {
    await cliEnqueue()
    const runId = await cliRegisterRun()
    const { taskId, token } = await cliClaim(runId)

    // First fail — success
    await runCliOk(BIN, ["fail", taskId, "--run", runId, "--token", String(token)], env)

    // Second fail — stale
    const result = await runCli(BIN, ["fail", taskId, "--run", runId, "--token", String(token)], env)
    expect(result.exitCode).toBe(4)
  })
})
