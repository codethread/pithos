/**
 * CLI process smoke tests for pithos enqueue and inspect task commands.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"

import { runCli, runCliOk } from "./_helpers/exec.ts"

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-enqueue-"))
}

describe("pithos enqueue (CLI process)", () => {
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

  it("enqueues a task and returns JSON with ok:true and task_ id", async () => {
    const stdout = await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "My task"],
      env,
    )
    const parsed = JSON.parse(stdout) as { ok: boolean; task: { id: string; status: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toMatch(/^task_/)
    expect(parsed.task.status).toBe("queued")
  })

  it("output includes scope_id, capability, and title", async () => {
    const stdout = await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "Verify fields"],
      env,
    )
    const parsed = JSON.parse(stdout) as {
      task: { scope_id: string; capability: string; title: string }
    }
    expect(parsed.task.scope_id).toBe("global")
    expect(parsed.task.capability).toBe("triage")
    expect(parsed.task.title).toBe("Verify fields")
  })

  it("exits 2 when --scope is missing", async () => {
    const result = await runCli(BIN, ["enqueue", "--capability", "triage", "--title", "Test"], env)
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --capability is missing", async () => {
    const result = await runCli(BIN, ["enqueue", "--scope", "global", "--title", "Test"], env)
    expect(result.exitCode).toBe(2)
  })

  it("exits 2 when --title is missing", async () => {
    const result = await runCli(BIN, ["enqueue", "--scope", "global", "--capability", "triage"], env)
    expect(result.exitCode).toBe(2)
  })

  it("exits 3 when scope does not exist", async () => {
    const result = await runCli(
      BIN,
      ["enqueue", "--scope", "repo:nonexistent", "--capability", "watch", "--title", "T"],
      env,
    )
    expect(result.exitCode).toBe(3)
  })

  it("reads body from --body-file", async () => {
    const bodyPath = join(tempDir, "body.md")
    writeFileSync(bodyPath, "Task body from file")

    const stdout = await runCliOk(
      BIN,
      [
        "enqueue",
        "--scope",
        "global",
        "--capability",
        "triage",
        "--title",
        "With body",
        "--body-file",
        bodyPath,
      ],
      env,
    )
    const parsed = JSON.parse(stdout) as { task: { body: string } }
    expect(parsed.task.body).toBe("Task body from file")
  })

  it("exits 2 when both --body and --body-file are supplied", async () => {
    const bodyPath = join(tempDir, "body.md")
    writeFileSync(bodyPath, "content")
    const result = await runCli(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "T", "--body", "inline", "--body-file", bodyPath],
      env,
    )
    expect(result.exitCode).toBe(2)
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["enqueue", "--help"], env)
    expect(stdout).toContain("pithos enqueue")
    expect(stdout).toContain("--scope")
    expect(stdout).toContain("--capability")
    expect(stdout).toContain("--title")
  })

  it("multiple enqueues create multiple tasks", async () => {
    for (const title of ["Task A", "Task B", "Task C"]) {
      await runCliOk(
        BIN,
        ["enqueue", "--scope", "global", "--capability", "triage", "--title", title],
        env,
      )
    }
    const db = new Database(dbPath)
    const rows = db.prepare("SELECT id FROM tasks").all() as { id: string }[]
    db.close()
    expect(rows).toHaveLength(3)
  })
})

describe("pithos inspect task (CLI process)", () => {
  let tempDir: string
  let dbPath: string
  let env: NodeJS.ProcessEnv
  let taskId: string

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    env = { ...process.env, PITHOS_DB: dbPath }
    await runCliOk(BIN, ["init"], env)

    const out = await runCliOk(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "Inspect test"],
      env,
    )
    const parsed = JSON.parse(out) as { task: { id: string } }
    taskId = parsed.task.id
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns the task as JSON with ok:true", async () => {
    const stdout = await runCliOk(BIN, ["inspect", "task", taskId], env)
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      task: { id: string; status: string; capability: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toBe(taskId)
    expect(parsed.task.status).toBe("queued")
    expect(parsed.task.capability).toBe("triage")
  })

  it("exits 3 for unknown task ID", async () => {
    const result = await runCli(BIN, ["inspect", "task", "task_unknown"], env)
    expect(result.exitCode).toBe(3)
  })

  it("shows help on --help", async () => {
    const stdout = await runCliOk(BIN, ["inspect", "task", "--help"], env)
    expect(stdout).toContain("inspect")
  })
})
