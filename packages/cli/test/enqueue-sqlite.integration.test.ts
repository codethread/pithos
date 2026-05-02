/**
 * Integration tests for pithos enqueueCommand and inspectTaskCommand — real SQLite. Unit coverage lives in src/commands/enqueue.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"

import { enqueueCommand } from "../src/commands/enqueue.ts"
import { inspectTaskCommand } from "../src/commands/inspect.ts"
import { makeDbServiceLive } from "../src/layers/db.ts"
import { makeIdServiceTest, IdServiceLive } from "../src/layers/ids.ts"
import { FsServiceLive } from "../src/layers/fs.ts"
import { initCommand } from "../src/commands/init.ts"
import { runRegisterCommand } from "../src/commands/run.ts"
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts"

const silentOutput = makeOutputServiceSilent()

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-enqueue-"))
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

describe("enqueueCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    dbLayer = makeDbServiceLive(dbPath)
    await Effect.runPromise(Effect.provide(initCommand, Layer.merge(dbLayer, silentOutput)))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const makeLayer = (ids: string[] = ["task_test1"]) =>
    Layer.mergeAll(dbLayer, makeIdServiceTest(ids), FsServiceLive, silentOutput)

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
    const layer = Layer.mergeAll(dbLayer, IdServiceLive, FsServiceLive, silentOutput)
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

  it("outputs JSON with ok:true and task row on success", async () => {
    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Output test" }),
        Layer.mergeAll(dbLayer, makeIdServiceTest(["task_out1"]), FsServiceLive, out.layer),
      ),
    )

    expect(out.lines()).toHaveLength(1)
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      task: { id: string; status: string; scope_id: string; capability: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toBe("task_out1")
    expect(parsed.task.status).toBe("queued")
    expect(parsed.task.scope_id).toBe("global")
    expect(parsed.task.capability).toBe("triage")
    expect(out.errorLines()).toHaveLength(0)
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
    const runLayer = Layer.mergeAll(dbLayer, makeIdServiceTest(["run_creator"]), FsServiceLive, silentOutput)
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
    const runLayer = Layer.mergeAll(dbLayer, makeIdServiceTest(["run_actor"]), FsServiceLive, silentOutput)
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
    await Effect.runPromise(Effect.provide(initCommand, Layer.merge(dbLayer, silentOutput)))

    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([taskId]), FsServiceLive, silentOutput)
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
    const exit = await runEff(Effect.provide(inspectTaskCommand(taskId), Layer.merge(dbLayer, silentOutput)))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("fails NOT_FOUND for an unknown task ID", async () => {
    const exit = await runEff(Effect.provide(inspectTaskCommand("task_ghost"), Layer.merge(dbLayer, silentOutput)))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
