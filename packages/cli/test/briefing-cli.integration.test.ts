/**
 * CLI process smoke tests for pithos briefing command.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runCli, runCliOk } from "./_helpers/exec.ts"

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-briefing-cli-"))
}

describe("pithos briefing (CLI process)", () => {
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

  it("exits 0 and renders markdown with all four sections", async () => {
    const stdout = await runCliOk(BIN, ["briefing", "--agent", "pandora"], env)
    expect(stdout).toContain("## Pandora briefing")
    expect(stdout).toContain("### Needs Adam")
    expect(stdout).toContain("### Ready for review")
    expect(stdout).toContain("### Active")
    expect(stdout).toContain("### Stale / failed")
  })

  it("exits 0 without --agent flag (defaults to pandora)", async () => {
    const stdout = await runCliOk(BIN, ["briefing"], env)
    expect(stdout).toContain("## Pandora briefing")
  })

  it("includes as_of_event_id watermark in output", async () => {
    const stdout = await runCliOk(BIN, ["briefing"], env)
    expect(/as_of_event_id: \d+/.test(stdout)).toBe(true)
  })

  it("watermark is 0 on fresh DB after init (no events)", async () => {
    const stdout = await runCliOk(BIN, ["briefing"], env)
    expect(stdout).toContain("as_of_event_id: 0")
  })

  it("watermark increases after enqueue emits an event", async () => {
    await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "T1"],
      env,
    )
    const stdout = await runCliOk(BIN, ["briefing"], env)
    const match = /as_of_event_id: (\d+)/.exec(stdout)
    expect(match).toBeTruthy()
    expect(Number(match![1])).toBeGreaterThanOrEqual(1)
  })

  it("shows enqueued task in Active section", async () => {
    await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "My queued task"],
      env,
    )
    const stdout = await runCliOk(BIN, ["briefing"], env)
    expect(stdout).toContain("[queued]")
    expect(stdout).toContain("My queued task")
  })

  it("exits 2 for invalid --agent value", async () => {
    const result = await runCli(BIN, ["briefing", "--agent", "bogus"], env)
    expect(result.exitCode).toBe(2)
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["briefing", "--help"], env)
    expect(stdout).toContain("pithos briefing")
    expect(stdout).toContain("--agent")
    expect(stdout).toContain("as_of_event_id")
  })

  it("shows help on -h", async () => {
    const stdout = await runCliOk(BIN, ["briefing", "-h"], env)
    expect(stdout).toContain("pithos briefing")
  })

  it("includes completed artifact summary in briefing (full lifecycle)", async () => {
    // Enqueue
    const enqueueOut = await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "Artifact task"],
      env,
    )
    const taskId = (JSON.parse(enqueueOut) as { task: { id: string } }).task.id

    // Register run
    const runOut = await runCliOk(BIN, ["run", "register", "--agent-kind", "envy"], env)
    const runId = (JSON.parse(runOut) as { run: { id: string } }).run.id

    // Claim
    const claimOut = await runCliOk(
      BIN,
      ["claim", "--run", runId, "--scope", "global", "--capability", "triage"],
      env,
    )
    const token = (JSON.parse(claimOut) as { task: { fencing_token: number } }).task.fencing_token

    // Complete
    await runCliOk(BIN, ["complete", taskId, "--run", runId, "--token", String(token)], env)

    // Add worker-completion artifact
    const reportFile = join(tempDir, "report.md")
    writeFileSync(reportFile, "Task complete. All tests pass.")
    await runCliOk(
      BIN,
      [
        "artifact", "add",
        "--task", taskId,
        "--run", runId,
        "--kind", "worker-completion",
        "--title", "Worker report",
        "--body-file", reportFile,
      ],
      env,
    )

    const stdout = await runCliOk(BIN, ["briefing"], env)
    // Done task in Ready for review
    expect(stdout).toContain("[done]")
    expect(stdout).toContain("Artifact task")
    // Artifact summary nested under the done task
    expect(stdout).toContain("worker-completion")
    expect(stdout).toContain("Worker report")
  })
})
