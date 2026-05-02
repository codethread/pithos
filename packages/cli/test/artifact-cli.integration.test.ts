/**
 * CLI process smoke tests for pithos artifact add command.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runCli, runCliOk } from "./_helpers/exec.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-artifact-"))
}

// ---------------------------------------------------------------------------
// CLI process smoke tests
// ---------------------------------------------------------------------------

describe("pithos artifact add (CLI process)", () => {
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
      ["enqueue", "--scope", "global", "--capability", "watch", "--title", "Test task"],
      env,
    )
    return (JSON.parse(out) as { task: { id: string } }).task.id
  }

  const cliRegisterRun = async (): Promise<string> => {
    const out = await runCliOk(BIN, ["run", "register", "--agent-kind", "envy"], env)
    return (JSON.parse(out) as { run: { id: string } }).run.id
  }

  it("adds a worker-completion artifact and returns ok:true", async () => {
    const taskId = await cliEnqueue()
    const runId = await cliRegisterRun()

    const stdout = await runCliOk(
      BIN,
      [
        "artifact",
        "add",
        "--task",
        taskId,
        "--run",
        runId,
        "--kind",
        "worker-completion",
        "--title",
        "Worker report",
      ],
      env,
    )

    const parsed = JSON.parse(stdout) as {
      ok: boolean
      artifact: { id: string; kind: string; title: string; task_id: string; run_id: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.artifact.kind).toBe("worker-completion")
    expect(parsed.artifact.title).toBe("Worker report")
    expect(parsed.artifact.task_id).toBe(taskId)
    expect(parsed.artifact.run_id).toBe(runId)
    expect(parsed.artifact.id).toMatch(/^artifact_/)
  })

  it("reads body from --body-file", async () => {
    const taskId = await cliEnqueue()
    const runId = await cliRegisterRun()

    const reportPath = join(tempDir, "report.md")
    const reportContent = "## Summary\n\nAll good."
    writeFileSync(reportPath, reportContent)

    const stdout = await runCliOk(
      BIN,
      [
        "artifact",
        "add",
        "--task",
        taskId,
        "--run",
        runId,
        "--kind",
        "worker-completion",
        "--title",
        "Report",
        "--body-file",
        reportPath,
      ],
      env,
    )

    const parsed = JSON.parse(stdout) as {
      ok: boolean
      artifact: { id: string; body: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.artifact.body).toBe(reportContent)
  })

  it("inspect task shows artifact after add", async () => {
    const taskId = await cliEnqueue()
    const runId = await cliRegisterRun()

    await runCliOk(
      BIN,
      [
        "artifact",
        "add",
        "--task",
        taskId,
        "--run",
        runId,
        "--kind",
        "worker-completion",
        "--title",
        "Completion report",
      ],
      env,
    )

    const inspectOut = await runCliOk(BIN, ["inspect", "task", taskId], env)
    const inspected = JSON.parse(inspectOut) as {
      ok: boolean
      task: { id: string }
      artifacts: { kind: string; title: string }[]
    }

    expect(inspected.ok).toBe(true)
    expect(inspected.artifacts).toHaveLength(1)
    expect(inspected.artifacts[0]!.kind).toBe("worker-completion")
    expect(inspected.artifacts[0]!.title).toBe("Completion report")
  })

  it("exits 2 when --task is missing", async () => {
    const runId = await cliRegisterRun()
    const result = await runCli(
      BIN,
      ["artifact", "add", "--run", runId, "--kind", "worker-completion", "--title", "Report"],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --run is missing", async () => {
    const taskId = await cliEnqueue()
    const result = await runCli(
      BIN,
      ["artifact", "add", "--task", taskId, "--kind", "worker-completion", "--title", "Report"],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --kind is missing", async () => {
    const taskId = await cliEnqueue()
    const runId = await cliRegisterRun()
    const result = await runCli(
      BIN,
      ["artifact", "add", "--task", taskId, "--run", runId, "--title", "Report"],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --title is missing", async () => {
    const taskId = await cliEnqueue()
    const runId = await cliRegisterRun()
    const result = await runCli(
      BIN,
      ["artifact", "add", "--task", taskId, "--run", runId, "--kind", "worker-completion"],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("exits 1 when --body-file does not exist", async () => {
    const taskId = await cliEnqueue()
    const runId = await cliRegisterRun()
    const result = await runCli(
      BIN,
      [
        "artifact",
        "add",
        "--task",
        taskId,
        "--run",
        runId,
        "--kind",
        "worker-completion",
        "--title",
        "Report",
        "--body-file",
        "/nonexistent/report.md",
      ],
      env,
    )
    expect(result.exitCode).not.toBe(0)
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["artifact", "add", "--help"], env)
    expect(stdout).toContain("pithos artifact add")
    expect(stdout).toContain("--task")
    expect(stdout).toContain("--run")
    expect(stdout).toContain("--kind")
    expect(stdout).toContain("--title")
    expect(stdout).toContain("--body-file")
  })
})
