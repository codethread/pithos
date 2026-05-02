/**
 * CLI process smoke tests for pithos tail command.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runCli, runCliOk } from "./_helpers/exec.ts"

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-tail-cli-"))
}

describe("pithos tail (CLI process)", () => {
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

  it("returns ok:true with empty events on fresh DB", async () => {
    const stdout = await runCliOk(BIN, ["tail"], env)
    const parsed = JSON.parse(stdout) as { ok: boolean; events: unknown[]; count: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.count).toBe(0)
    expect(parsed.events).toHaveLength(0)
  })

  it("returns events after enqueue", async () => {
    await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "T1"],
      env,
    )
    const stdout = await runCliOk(BIN, ["tail"], env)
    const parsed = JSON.parse(stdout) as { events: { type: string }[]; count: number }
    expect(parsed.count).toBeGreaterThan(0)
    const types = parsed.events.map((e) => e.type)
    expect(types).toContain("task.created")
  })

  it("respects --limit flag", async () => {
    for (let i = 1; i <= 5; i++) {
      await runCliOk(
        BIN,
        ["enqueue", "--scope", "global", "--capability", "triage", "--title", `Task ${i}`],
        env,
      )
    }
    const stdout = await runCliOk(BIN, ["tail", "--limit", "3"], env)
    const parsed = JSON.parse(stdout) as { events: unknown[]; count: number }
    expect(parsed.count).toBe(3)
    expect(parsed.events).toHaveLength(3)
  })

  it("events are ordered oldest-first (ascending by id)", async () => {
    await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "a", "--title", "First"],
      env,
    )
    await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "b", "--title", "Second"],
      env,
    )
    const stdout = await runCliOk(BIN, ["tail", "--limit", "10"], env)
    const parsed = JSON.parse(stdout) as { events: { id: number }[] }
    const ids = parsed.events.map((e) => e.id)
    expect(ids.length).toBeGreaterThan(1)
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]!)
    }
  })

  it("exits 2 when --limit is zero", async () => {
    const result = await runCli(BIN, ["tail", "--limit", "0"], env)
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --limit is negative", async () => {
    const result = await runCli(BIN, ["tail", "--limit", "-1"], env)
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --limit is not a number", async () => {
    const result = await runCli(BIN, ["tail", "--limit", "abc"], env)
    expect(result.exitCode).toBe(2)
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["tail", "--help"], env)
    expect(stdout).toContain("pithos tail")
    expect(stdout).toContain("--limit")
  })

  it("shows help on -h", async () => {
    const stdout = await runCliOk(BIN, ["tail", "-h"], env)
    expect(stdout).toContain("pithos tail")
  })

  it("each event has required fields: id, type, created_at, payload_json, task_id, run_id, actor_run_id", async () => {
    await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "Fields test"],
      env,
    )
    const stdout = await runCliOk(BIN, ["tail"], env)
    const parsed = JSON.parse(stdout) as {
      events: {
        id: number
        type: string
        created_at: string
        payload_json: string
        task_id: string | null
        run_id: string | null
        actor_run_id: string | null
      }[]
    }
    expect(parsed.events.length).toBeGreaterThan(0)
    for (const event of parsed.events) {
      expect(typeof event.id).toBe("number")
      expect(typeof event.type).toBe("string")
      expect(typeof event.created_at).toBe("string")
      expect(typeof event.payload_json).toBe("string")
      expect("task_id" in event).toBe(true)
      expect("run_id" in event).toBe(true)
      expect("actor_run_id" in event).toBe(true)
    }
  })

  it("count field matches events array length in output", async () => {
    await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "Count check"],
      env,
    )
    const stdout = await runCliOk(BIN, ["tail"], env)
    const parsed = JSON.parse(stdout) as { count: number; events: unknown[] }
    expect(parsed.count).toBe(parsed.events.length)
  })
})
