/**
 * CLI process smoke tests for pithos run end command.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runCli, runCliOk } from "./_helpers/exec.ts"

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-run-"))
}

describe("pithos run end (CLI process)", () => {
  let tempDir: string
  let dbPath: string
  let env: NodeJS.ProcessEnv
  let runId: string

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    env = { ...process.env, PITHOS_DB: dbPath }
    await runCliOk(BIN, ["init"], env)
    const out = await runCliOk(
      BIN,
      ["run", "register", "--agent-kind", "envy"],
      env,
    )
    const parsed = JSON.parse(out) as { run: { id: string } }
    runId = parsed.run.id
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("ends a run and returns JSON with ok:true and ended_at set", async () => {
    const stdout = await runCliOk(BIN, ["run", "end", "--run", runId], env)
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      run: { status: string; ended_at: string | null }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.run.status).toBe("ended")
    expect(parsed.run.ended_at).not.toBeNull()
  })

  it("ends a run with --status failed", async () => {
    const stdout = await runCliOk(
      BIN,
      ["run", "end", "--run", runId, "--status", "failed", "--summary", "something went wrong"],
      env,
    )
    const parsed = JSON.parse(stdout) as { run: { status: string; last_summary: string } }
    expect(parsed.run.status).toBe("failed")
    expect(parsed.run.last_summary).toBe("something went wrong")
  })

  it("exits 2 when --run is missing", async () => {
    const result = await runCli(BIN, ["run", "end"], env)
    expect(result.exitCode).toBe(2)
  })

  it("exits 3 for unknown run ID", async () => {
    const result = await runCli(BIN, ["run", "end", "--run", "run_nonexistent"], env)
    expect(result.exitCode).toBe(3)
  })

  it("exits 2 for an invalid --status value", async () => {
    const result = await runCli(BIN, ["run", "end", "--run", runId, "--status", "typo"], env)
    expect(result.exitCode).toBe(2)
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["run", "end", "--help"], env)
    expect(stdout).toContain("pithos run end")
    expect(stdout).toContain("--run")
  })
})
