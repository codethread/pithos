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
import { scopeUpsertCommand } from "../src/commands/scope.ts"
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

  const registerRun = async (runId: string): Promise<void> => {
    await Effect.runPromise(
      Effect.provide(
        runRegisterCommand({ agentKind: "envy", run: runId }),
        Layer.mergeAll(dbLayer, makeIdServiceTest([runId]), FsServiceLive, silentOutput),
      ),
    )
  }

  const upsertRepoScope = async (pathSuffix: string): Promise<string> => {
    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(
        scopeUpsertCommand({ kind: "repo", path: join(tempDir, pathSuffix) }),
        Layer.merge(dbLayer, out.layer),
      ),
    )
    const parsed = JSON.parse(out.lines()[0]!) as { ok: boolean; scope: { id: string } }
    expect(parsed.ok).toBe(true)
    return parsed.scope.id
  }

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
    const row = db.prepare("SELECT body FROM tasks").get() as { body: string } | undefined
    db.close()

    expect(row?.body).toBe("")
  })

  it("appends a task.created event with depends_on_task_ids", async () => {
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({
          scope: "global",
          capability: "watch",
          title: "Watch task",
          dependsOn: [],
        }),
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
      depends_on_task_ids: string[]
    }
    expect(payload.scope_id).toBe("global")
    expect(payload.capability).toBe("watch")
    expect(payload.title).toBe("Watch task")
    expect(payload.depends_on_task_ids).toEqual([])
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

  it("records created_by_run_id when --run is provided", async () => {
    await registerRun("run_creator")

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

  it("creates repeatable cross-scope dependency edges", async () => {
    const repoScopeId = await upsertRepoScope("repo-a")

    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: repoScopeId, capability: "build", title: "Backend blocker" }),
        makeLayer(["task_backend"]),
      ),
    )
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({
          scope: "global",
          capability: "build",
          title: "Frontend task",
          dependsOn: ["task_backend"],
        }),
        makeLayer(["task_frontend"]),
      ),
    )

    const db = new Database(dbPath)
    const dependencyRows = db
      .prepare(
        `SELECT task_id, depends_on_task_id
         FROM task_dependencies
         ORDER BY task_id ASC, depends_on_task_id ASC`,
      )
      .all() as { task_id: string; depends_on_task_id: string }[]
    db.close()

    expect(dependencyRows).toEqual([
      { task_id: "task_frontend", depends_on_task_id: "task_backend" },
    ])
  })

  it("fails NOT_FOUND for an unknown --depends-on target", async () => {
    const exit = await runEff(
      Effect.provide(
        enqueueCommand({
          scope: "global",
          capability: "triage",
          title: "Bad dependency",
          dependsOn: ["task_ghost"],
        }),
        makeLayer(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const cause = Exit.isFailure(exit) ? String(exit.cause) : ""
    expect(cause).toContain("Dependency task not found")
  })

  it("fails VALIDATION_ERROR for duplicate --depends-on values", async () => {
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Parent" }),
        makeLayer(["task_parent"]),
      ),
    )

    const exit = await runEff(
      Effect.provide(
        enqueueCommand({
          scope: "global",
          capability: "triage",
          title: "Child",
          dependsOn: ["task_parent", "task_parent"],
        }),
        makeLayer(["task_child"]),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const cause = Exit.isFailure(exit) ? String(exit.cause) : ""
    expect(cause).toContain("Duplicate --depends-on task IDs")
  })

  it("fails USER_ERROR when a dependency target has already been superseded", async () => {
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Old blocker" }),
        makeLayer(["task_old"]),
      ),
    )
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "triage", title: "Replacement blocker" }),
        makeLayer(["task_new"]),
      ),
    )

    const db = new Database(dbPath)
    db.prepare(
      `INSERT INTO task_supersessions (old_task_id, new_task_id, reason)
       VALUES ('task_old', 'task_new', 'replacement')`,
    ).run()
    db.close()

    const exit = await runEff(
      Effect.provide(
        enqueueCommand({
          scope: "global",
          capability: "triage",
          title: "Blocked by old task",
          dependsOn: ["task_old"],
        }),
        makeLayer(["task_child"]),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const cause = Exit.isFailure(exit) ? String(exit.cause) : ""
    expect(cause).toContain("Dependency task task_old has been superseded by task_new")
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
    await registerRun("run_actor")

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

  const upsertRepoScope = async (pathSuffix: string): Promise<string> => {
    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(
        scopeUpsertCommand({ kind: "repo", path: join(tempDir, pathSuffix) }),
        Layer.merge(dbLayer, out.layer),
      ),
    )
    const parsed = JSON.parse(out.lines()[0]!) as { ok: boolean; scope: { id: string } }
    expect(parsed.ok).toBe(true)
    return parsed.scope.id
  }

  it("returns machine-readable dependencies, dependents, and unresolved blockers", async () => {
    const repoScopeId = await upsertRepoScope("repo-b")

    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: repoScopeId, capability: "build", title: "Backend blocker" }),
        makeLayer(["task_backend"]),
      ),
    )
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({
          scope: "global",
          capability: "build",
          title: "Frontend work",
          dependsOn: ["task_backend"],
        }),
        makeLayer(["task_frontend"]),
      ),
    )

    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(inspectTaskCommand("task_frontend"), Layer.merge(dbLayer, out.layer)),
    )

    expect(out.lines()).toHaveLength(1)
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      task: {
        id: string
        scope_id: string
        claimable: boolean
        unresolved_dependency_ids: string[]
      }
      dependencies: { id: string; scope_id: string; status: string; title: string }[]
      dependents: { id: string; scope_id: string; status: string; title: string }[]
      supersedes: unknown
      superseded_by: unknown
      artifacts: unknown[]
    }

    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toBe("task_frontend")
    expect(parsed.task.scope_id).toBe("global")
    expect(parsed.task.claimable).toBe(false)
    expect(parsed.task.unresolved_dependency_ids).toEqual(["task_backend"])
    expect(parsed.dependencies).toEqual([
      {
        id: "task_backend",
        scope_id: repoScopeId,
        status: "queued",
        title: "Backend blocker",
      },
    ])
    expect(parsed.dependents).toEqual([])
    expect(parsed.supersedes).toBeNull()
    expect(parsed.superseded_by).toBeNull()
    expect(parsed.artifacts).toEqual([])
  })

  it("returns direct dependents ordered as summaries", async () => {
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "build", title: "Shared blocker" }),
        makeLayer(["task_blocker"]),
      ),
    )
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({
          scope: "global",
          capability: "build",
          title: "Dependent A",
          dependsOn: ["task_blocker"],
        }),
        makeLayer(["task_dependent_a"]),
      ),
    )
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({
          scope: "global",
          capability: "build",
          title: "Dependent B",
          dependsOn: ["task_blocker"],
        }),
        makeLayer(["task_dependent_b"]),
      ),
    )

    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(inspectTaskCommand("task_blocker"), Layer.merge(dbLayer, out.layer)),
    )

    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      task: { id: string; claimable: boolean; unresolved_dependency_ids: string[] }
      dependencies: unknown[]
      dependents: { id: string; scope_id: string; status: string; title: string }[]
    }

    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toBe("task_blocker")
    expect(parsed.task.claimable).toBe(true)
    expect(parsed.task.unresolved_dependency_ids).toEqual([])
    expect(parsed.dependencies).toEqual([])
    expect(parsed.dependents).toEqual([
      {
        id: "task_dependent_a",
        scope_id: "global",
        status: "queued",
        title: "Dependent A",
      },
      {
        id: "task_dependent_b",
        scope_id: "global",
        status: "queued",
        title: "Dependent B",
      },
    ])
  })

  it("fails NOT_FOUND for an unknown task ID", async () => {
    const exit = await runEff(Effect.provide(inspectTaskCommand("task_ghost"), Layer.merge(dbLayer, silentOutput)))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
