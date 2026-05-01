/**
 * Tests for Slice 7: enqueue a task and inspect it.
 *
 * Layers:
 *  1. Unit  — command logic with fake DB/ID/FS services
 *  2. Integration — real SQLite in temp dir
 *  3. parseArgs  — enqueue and inspect task routing
 *  4. CLI process — smoke tests for `pithos enqueue` and `pithos inspect task`
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import Database from "better-sqlite3"

import { enqueueCommand } from "../src/commands/enqueue.ts"
import { inspectTaskCommand } from "../src/commands/inspect.ts"
import { parseArgs } from "../src/cli/args.ts"
import { makeDbServiceLive, makeDbServiceTest } from "../src/layers/db.ts"
import { makeIdServiceTest, IdServiceLive } from "../src/layers/ids.ts"
import { makeFsServiceTest, FsServiceLive } from "../src/layers/fs.ts"
import { initCommand } from "../src/commands/init.ts"
import { runRegisterCommand } from "../src/commands/run.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-enqueue-"))
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / ID / FS services
// ---------------------------------------------------------------------------

describe("enqueueCommand (unit — fake DB)", () => {
  it("fails VALIDATION_ERROR when --scope is missing", async () => {
    const layer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest([]), makeFsServiceTest())
    const exit = await runEff(
      Effect.provide(
        enqueueCommand({ scope: undefined, capability: "watch", title: "Test" }),
        layer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --capability is missing", async () => {
    const layer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest([]), makeFsServiceTest())
    const exit = await runEff(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: undefined, title: "Test" }),
        layer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --title is missing", async () => {
    const layer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest([]), makeFsServiceTest())
    const exit = await runEff(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "watch", title: undefined }),
        layer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("inspectTaskCommand (unit — fake DB)", () => {
  it("fails NOT_FOUND when task is absent from fake DB", async () => {
    const exit = await runEff(
      Effect.provide(inspectTaskCommand("task_missing"), makeDbServiceTest()),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Integration — real SQLite
// ---------------------------------------------------------------------------

describe("enqueueCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    dbLayer = makeDbServiceLive(dbPath)
    await Effect.runPromise(Effect.provide(initCommand, dbLayer))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const makeLayer = (ids: string[] = ["task_test1"]) =>
    Layer.mergeAll(dbLayer, makeIdServiceTest(ids), FsServiceLive)

  it("creates a queued task with a task_ prefixed ID", async () => {
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Test task" }),
        makeLayer(),
      ),
    )

    const db = new Database(dbPath)
    const rows = db
      .prepare("SELECT id, status, capability FROM tasks")
      .all() as { id: string; status: string; capability: string }[]
    db.close()

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toMatch(/^task_/)
    expect(rows[0]?.status).toBe("queued")
    expect(rows[0]?.capability).toBe("triage")
  })

  it("generates a task_ prefixed ID from IdService", async () => {
    const layer = Layer.mergeAll(dbLayer, IdServiceLive, FsServiceLive)
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "ID test" }),
        layer,
      ),
    )

    const db = new Database(dbPath)
    const rows = db.prepare("SELECT id FROM tasks").all() as { id: string }[]
    db.close()

    expect(rows[0]?.id).toMatch(/^task_/)
  })

  it("stores title and body", async () => {
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "My task", body: "Do the thing" }),
        makeLayer(),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT title, body FROM tasks WHERE capability = 'triage'")
      .get() as { title: string; body: string } | undefined
    db.close()

    expect(row?.title).toBe("My task")
    expect(row?.body).toBe("Do the thing")
  })

  it("stores empty body by default", async () => {
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "No body" }),
        makeLayer(),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT body FROM tasks")
      .get() as { body: string } | undefined
    db.close()

    expect(row?.body).toBe("")
  })

  it("appends a task.created event", async () => {
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "watch", title: "Watch task" }),
        makeLayer(),
      ),
    )

    const db = new Database(dbPath)
    const events = db
      .prepare("SELECT type, payload_json FROM events WHERE type = 'task.created'")
      .all() as { type: string; payload_json: string }[]
    db.close()

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("task.created")

    const payload = JSON.parse(events[0]?.payload_json ?? "{}") as {
      scope_id: string
      capability: string
      title: string
    }
    expect(payload.scope_id).toBe("global")
    expect(payload.capability).toBe("watch")
    expect(payload.title).toBe("Watch task")
  })

  it("reads body from --body-file when provided", async () => {
    const bodyPath = join(tempDir, "body.md")
    writeFileSync(bodyPath, "File body content")

    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "watch", title: "File body task", bodyFile: bodyPath }),
        makeLayer(),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT body FROM tasks WHERE capability = 'watch'")
      .get() as { body: string } | undefined
    db.close()

    expect(row?.body).toBe("File body content")
  })

  it("fails NOT_FOUND when scope does not exist", async () => {
    const exit = await runEff(
      Effect.provide(
        enqueueCommand({ scope: "repo:nonexistent/scope", capability: "watch", title: "Test" }),
        makeLayer(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("stores scope_id, capability, status correctly", async () => {
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Scoped task" }),
        makeLayer(),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT scope_id, capability, status FROM tasks")
      .get() as { scope_id: string; capability: string; status: string } | undefined
    db.close()

    expect(row?.scope_id).toBe("global")
    expect(row?.capability).toBe("triage")
    expect(row?.status).toBe("queued")
  })

  it("records created_by_run_id when --run is provided", async () => {
    // First register a real run so the FK constraint is satisfied.
    const runLayer = Layer.mergeAll(dbLayer, makeIdServiceTest(["run_creator"]), FsServiceLive)
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_creator" }), runLayer),
    )

    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Created by run", run: "run_creator" }),
        makeLayer(["task_created_by_run"]),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT created_by_run_id FROM tasks")
      .get() as { created_by_run_id: string | null } | undefined
    db.close()

    expect(row?.created_by_run_id).toBe("run_creator")
  })

  it("fails NOT_FOUND for an unknown --run id", async () => {
    const exit = await runEff(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Bad run", run: "run_nonexistent" }),
        makeLayer(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("stores parent_id when valid --parent-id is provided", async () => {
    // Create a parent task first.
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Parent" }),
        makeLayer(["task_parent"]),
      ),
    )
    // Create child task referencing parent.
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Child", parentId: "task_parent" }),
        makeLayer(["task_child"]),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT parent_id FROM tasks WHERE id = 'task_child'")
      .get() as { parent_id: string | null } | undefined
    db.close()

    expect(row?.parent_id).toBe("task_parent")
  })

  it("fails NOT_FOUND for an unknown --parent-id", async () => {
    const exit = await runEff(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Bad parent", parentId: "task_ghost" }),
        makeLayer(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when both --body and --body-file are supplied", async () => {
    const bodyPath = join(tempDir, "body.md")
    writeFileSync(bodyPath, "file content")
    const exit = await runEff(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Both", body: "inline", bodyFile: bodyPath }),
        makeLayer(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("stores actor_run_id in task.created event when --run is supplied", async () => {
    // Register a run first.
    const runLayer = Layer.mergeAll(dbLayer, makeIdServiceTest(["run_actor"]), FsServiceLive)
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_actor" }), runLayer),
    )

    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "With actor", run: "run_actor" }),
        makeLayer(["task_actor_test"]),
      ),
    )

    const db = new Database(dbPath)
    const event = db
      .prepare("SELECT actor_run_id FROM events WHERE type = 'task.created'")
      .get() as { actor_run_id: string | null } | undefined
    db.close()

    expect(event?.actor_run_id).toBe("run_actor")
  })
})

describe("inspectTaskCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>
  const taskId = "task_inspect1"

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    dbLayer = makeDbServiceLive(dbPath)
    await Effect.runPromise(Effect.provide(initCommand, dbLayer))

    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([taskId]), FsServiceLive)
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "For inspection" }),
        layer,
      ),
    )
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns the task row for a known ID", async () => {
    const exit = await runEff(Effect.provide(inspectTaskCommand(taskId), dbLayer))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("fails NOT_FOUND for an unknown task ID", async () => {
    const exit = await runEff(Effect.provide(inspectTaskCommand("task_ghost"), dbLayer))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. parseArgs — enqueue and inspect task routing
// ---------------------------------------------------------------------------

describe("parseArgs — enqueue", () => {
  it("parses all required flags", async () => {
    const result = await Effect.runPromise(
      parseArgs(["enqueue", "--scope", "global", "--capability", "triage", "--title", "Test"]),
    )
    expect(result).toMatchObject({
      command: "enqueue",
      scope: "global",
      capability: "triage",
      title: "Test",
    })
  })

  it("parses --body-file flag", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "enqueue",
        "--scope",
        "global",
        "--capability",
        "watch",
        "--title",
        "T",
        "--body-file",
        "/tmp/body.md",
      ]),
    )
    expect(result).toMatchObject({ command: "enqueue", bodyFile: "/tmp/body.md" })
  })

  it("parses --body flag", async () => {
    const result = await Effect.runPromise(
      parseArgs(["enqueue", "--scope", "global", "--capability", "watch", "--title", "T", "--body", "inline text"]),
    )
    expect(result).toMatchObject({ command: "enqueue", body: "inline text" })
  })

  it("parses --run and --parent-id flags", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "enqueue",
        "--scope",
        "global",
        "--capability",
        "watch",
        "--title",
        "T",
        "--run",
        "run_abc",
        "--parent-id",
        "task_parent",
      ]),
    )
    expect(result).toMatchObject({ command: "enqueue", run: "run_abc", parentId: "task_parent" })
  })

  it("routes 'enqueue --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["enqueue", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "enqueue" })
  })

  it("returns undefined for optional flags when absent", async () => {
    const result = await Effect.runPromise(
      parseArgs(["enqueue", "--scope", "global", "--capability", "watch", "--title", "T"]),
    )
    expect(result).toMatchObject({
      command: "enqueue",
      body: undefined,
      bodyFile: undefined,
      run: undefined,
      parentId: undefined,
    })
  })
})

describe("parseArgs — inspect task", () => {
  it("parses 'inspect task <id>'", async () => {
    const result = await Effect.runPromise(parseArgs(["inspect", "task", "task_abc"]))
    expect(result).toMatchObject({ command: "inspect:task", id: "task_abc" })
  })

  it("routes 'inspect task --help' to help", async () => {
    const result = await Effect.runPromise(parseArgs(["inspect", "task", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "inspect:task" })
  })
})

// ---------------------------------------------------------------------------
// 4. CLI process smoke tests
// ---------------------------------------------------------------------------

describe("pithos enqueue (CLI process)", () => {
  let tempDir: string
  let dbPath: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    env = { ...process.env, PITHOS_DB: dbPath }
    execFileSync(BIN, ["init"], { env, encoding: "utf-8" })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("enqueues a task and returns JSON with ok:true and task_ id", () => {
    const stdout = execFileSync(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "My task"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as { ok: boolean; task: { id: string; status: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toMatch(/^task_/)
    expect(parsed.task.status).toBe("queued")
  })

  it("output includes scope_id, capability, and title", () => {
    const stdout = execFileSync(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "Verify fields"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as {
      task: { scope_id: string; capability: string; title: string }
    }
    expect(parsed.task.scope_id).toBe("global")
    expect(parsed.task.capability).toBe("triage")
    expect(parsed.task.title).toBe("Verify fields")
  })

  it("exits 2 when --scope is missing", () => {
    let status: number | undefined
    try {
      execFileSync(BIN, ["enqueue", "--capability", "triage", "--title", "Test"], { env, encoding: "utf-8" })
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(2)
  })

  it("exits 2 when --capability is missing", () => {
    let status: number | undefined
    try {
      execFileSync(BIN, ["enqueue", "--scope", "global", "--title", "Test"], { env, encoding: "utf-8" })
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(2)
  })

  it("exits 2 when --title is missing", () => {
    let status: number | undefined
    try {
      execFileSync(BIN, ["enqueue", "--scope", "global", "--capability", "triage"], { env, encoding: "utf-8" })
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(2)
  })

  it("exits 3 when scope does not exist", () => {
    let status: number | undefined
    try {
      execFileSync(
        BIN,
        ["enqueue", "--scope", "repo:nonexistent", "--capability", "watch", "--title", "T"],
        { env, encoding: "utf-8" },
      )
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(3)
  })

  it("reads body from --body-file", () => {
    const bodyPath = join(tempDir, "body.md")
    writeFileSync(bodyPath, "Task body from file")

    const stdout = execFileSync(
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
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(stdout) as { task: { body: string } }
    expect(parsed.task.body).toBe("Task body from file")
  })

  it("exits 2 when both --body and --body-file are supplied", () => {
    const bodyPath = join(tempDir, "body.md")
    writeFileSync(bodyPath, "content")
    let status: number | undefined
    try {
      execFileSync(
        BIN,
        ["enqueue", "--scope", "global", "--capability", "triage", "--title", "T", "--body", "inline", "--body-file", bodyPath],
        { env, encoding: "utf-8" },
      )
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(2)
  })

  it("shows help on --help", () => {
    const stdout = execFileSync(BIN, ["enqueue", "--help"], { env, encoding: "utf-8" })
    expect(stdout).toContain("pithos enqueue")
    expect(stdout).toContain("--scope")
    expect(stdout).toContain("--capability")
    expect(stdout).toContain("--title")
  })

  it("multiple enqueues create multiple tasks", () => {
    for (const title of ["Task A", "Task B", "Task C"]) {
      execFileSync(
        BIN,
        ["enqueue", "--scope", "global", "--capability", "triage", "--title", title],
        { env, encoding: "utf-8" },
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

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    env = { ...process.env, PITHOS_DB: dbPath }
    execFileSync(BIN, ["init"], { env, encoding: "utf-8" })

    const out = execFileSync(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "triage", "--title", "Inspect test"],
      { env, encoding: "utf-8" },
    )
    const parsed = JSON.parse(out) as { task: { id: string } }
    taskId = parsed.task.id
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns the task as JSON with ok:true", () => {
    const stdout = execFileSync(BIN, ["inspect", "task", taskId], { env, encoding: "utf-8" })
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      task: { id: string; status: string; capability: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toBe(taskId)
    expect(parsed.task.status).toBe("queued")
    expect(parsed.task.capability).toBe("triage")
  })

  it("exits 3 for unknown task ID", () => {
    let status: number | undefined
    try {
      execFileSync(BIN, ["inspect", "task", "task_unknown"], { env, encoding: "utf-8" })
    } catch (e: unknown) {
      status = (e as { status?: number }).status
    }
    expect(status).toBe(3)
  })

  it("shows help on --help", () => {
    const stdout = execFileSync(BIN, ["inspect", "task", "--help"], { env, encoding: "utf-8" })
    expect(stdout).toContain("inspect")
  })
})
