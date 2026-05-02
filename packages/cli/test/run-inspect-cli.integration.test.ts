/**
 * CLI process smoke tests for pithos inspect run command.
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

describe("pithos inspect run (CLI process)", () => {
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

  it("returns a registered run", async () => {
    const stdout = await runCliOk(BIN, ["inspect", "run", runId], env)
    const parsed = JSON.parse(stdout) as { ok: boolean; run: { id: string; agent_kind: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.run.id).toBe(runId)
    expect(parsed.run.agent_kind).toBe("envy")
  })

  it("returns updated state after run end", async () => {
    await runCliOk(BIN, ["run", "end", "--run", runId], env)
    const stdout = await runCliOk(BIN, ["inspect", "run", runId], env)
    const parsed = JSON.parse(stdout) as { run: { status: string; ended_at: string | null } }
    expect(parsed.run.status).toBe("ended")
    expect(parsed.run.ended_at).not.toBeNull()
  })

  it("exits 3 for unknown run ID", async () => {
    const result = await runCli(BIN, ["inspect", "run", "run_unknown"], env)
    expect(result.exitCode).toBe(3)
  })
})
