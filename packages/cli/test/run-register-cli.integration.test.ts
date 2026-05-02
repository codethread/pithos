/**
 * CLI process smoke tests for pithos run register command.
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

describe("pithos run register (CLI process)", () => {
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

  it("registers a run and returns JSON with ok:true", async () => {
    const stdout = await runCliOk(
      BIN,
      ["run", "register", "--agent-kind", "envy"],
      env,
    )
    const parsed = JSON.parse(stdout) as { ok: boolean; run: { id: string; status: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.run.id).toMatch(/^run_/)
    expect(parsed.run.status).toBe("starting")
  })

  it("exits 2 when --agent-kind is missing", async () => {
    const result = await runCli(BIN, ["run", "register"], env)
    expect(result.exitCode).toBe(2)
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["run", "register", "--help"], env)
    expect(stdout).toContain("pithos run register")
    expect(stdout).toContain("--agent-kind")
  })

  it("is idempotent with explicit --run ID", async () => {
    const out1 = await runCliOk(
      BIN,
      ["run", "register", "--agent-kind", "envy", "--run", "run_cli_idem"],
      env,
    )
    const out2 = await runCliOk(
      BIN,
      ["run", "register", "--agent-kind", "toil", "--run", "run_cli_idem"],
      env,
    )
    const r1 = JSON.parse(out1) as { run: { agent_kind: string } }
    const r2 = JSON.parse(out2) as { run: { agent_kind: string } }
    // Second call returns the original run unchanged
    expect(r1.run.agent_kind).toBe("envy")
    expect(r2.run.agent_kind).toBe("envy")
  })
})
