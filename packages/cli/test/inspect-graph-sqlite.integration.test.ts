import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"

import { enqueueCommand } from "../src/commands/enqueue.ts"
import { initCommand } from "../src/commands/init.ts"
import { inspectGraphCommand } from "../src/commands/inspect.ts"
import { runRegisterCommand } from "../src/commands/run.ts"
import { scopeUpsertCommand } from "../src/commands/scope.ts"
import { supersedeCommand } from "../src/commands/supersede.ts"
import { makeDbServiceLive } from "../src/layers/db.ts"
import { FsServiceLive } from "../src/layers/fs.ts"
import { makeIdServiceTest } from "../src/layers/ids.ts"
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts"

const silentOutput = makeOutputServiceSilent()

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-inspect-graph-"))
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

describe("inspectGraphCommand (integration — real SQLite)", () => {
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

  const makeLayer = (ids: string[] = ["task_generated"]) =>
    Layer.mergeAll(dbLayer, makeIdServiceTest(ids), FsServiceLive, silentOutput)

  const registerRun = async (runId: string): Promise<void> => {
    await Effect.runPromise(
      Effect.provide(
        runRegisterCommand({ agentKind: "pandora", run: runId }),
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

  const enqueue = async (
    taskId: string,
    opts: {
      scope?: string
      capability?: string
      title?: string
      dependsOn?: readonly string[]
    } = {},
  ): Promise<void> => {
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({
          scope: opts.scope ?? "global",
          capability: opts.capability ?? "triage",
          title: opts.title ?? `Task ${taskId}`,
          dependsOn: opts.dependsOn,
        }),
        makeLayer([taskId]),
      ),
    )
  }

  it("returns a closed transitive dependency/supersession graph around one task", async () => {
    const designScopeId = await upsertRepoScope("design")
    const backendScopeId = await upsertRepoScope("backend")
    const frontendScopeId = await upsertRepoScope("frontend")

    await registerRun("run_actor")
    await enqueue("task_a", {
      scope: designScopeId,
      capability: "design",
      title: "Finalize API sketch",
    })
    await enqueue("task_b", {
      scope: backendScopeId,
      capability: "build",
      title: "Original API task",
      dependsOn: ["task_a"],
    })
    await enqueue("task_c", {
      scope: frontendScopeId,
      capability: "build",
      title: "Update FE client",
      dependsOn: ["task_b"],
    })

    const db = new Database(dbPath)
    db.prepare(`UPDATE tasks SET status = 'done' WHERE id = 'task_a'`).run()
    db.close()

    await Effect.runPromise(
      Effect.provide(
        supersedeCommand({
          taskId: "task_b",
          run: "run_actor",
          reason: "Replace the wrong middle task",
          title: "Fix API",
        }),
        makeLayer(["task_d"]),
      ),
    )

    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(inspectGraphCommand("task_d"), Layer.merge(dbLayer, out.layer)),
    )

    expect(out.lines()).toHaveLength(1)
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      graph: {
        selector: { kind: string; value: string }
        nodes: {
          id: string
          scope_id: string
          capability: string
          status: string
          title: string
          claimable: boolean
          unresolved_dependency_ids: string[]
          supersedes_task_id: string | null
          superseded_by_task_id: string | null
        }[]
        edges: (
          | {
              kind: "depends_on"
              from_task_id: string
              to_task_id: string
              satisfied: boolean
            }
          | {
              kind: "supersedes"
              from_task_id: string
              to_task_id: string
            }
        )[]
      }
    }

    expect(parsed.ok).toBe(true)
    expect(parsed.graph.selector).toEqual({ kind: "task", value: "task_d" })
    expect(parsed.graph.nodes).toEqual([
      {
        id: "task_a",
        scope_id: designScopeId,
        capability: "design",
        status: "done",
        title: "Finalize API sketch",
        claimable: false,
        unresolved_dependency_ids: [],
        supersedes_task_id: null,
        superseded_by_task_id: null,
      },
      {
        id: "task_b",
        scope_id: backendScopeId,
        capability: "build",
        status: "cancelled",
        title: "Original API task",
        claimable: false,
        unresolved_dependency_ids: [],
        supersedes_task_id: null,
        superseded_by_task_id: "task_d",
      },
      {
        id: "task_c",
        scope_id: frontendScopeId,
        capability: "build",
        status: "queued",
        title: "Update FE client",
        claimable: false,
        unresolved_dependency_ids: ["task_d"],
        supersedes_task_id: null,
        superseded_by_task_id: null,
      },
      {
        id: "task_d",
        scope_id: backendScopeId,
        capability: "build",
        status: "queued",
        title: "Fix API",
        claimable: true,
        unresolved_dependency_ids: [],
        supersedes_task_id: "task_b",
        superseded_by_task_id: null,
      },
    ])
    expect(parsed.graph.edges).toEqual([
      {
        kind: "depends_on",
        from_task_id: "task_b",
        to_task_id: "task_a",
        satisfied: true,
      },
      {
        kind: "depends_on",
        from_task_id: "task_c",
        to_task_id: "task_d",
        satisfied: false,
      },
      {
        kind: "depends_on",
        from_task_id: "task_d",
        to_task_id: "task_a",
        satisfied: true,
      },
      {
        kind: "supersedes",
        from_task_id: "task_d",
        to_task_id: "task_b",
      },
    ])

    const nodeIds = new Set(parsed.graph.nodes.map((node) => node.id))
    for (const node of parsed.graph.nodes) {
      for (const unresolvedDependencyId of node.unresolved_dependency_ids) {
        expect(nodeIds.has(unresolvedDependencyId)).toBe(true)
      }
      expect(node.supersedes_task_id === null || nodeIds.has(node.supersedes_task_id)).toBe(true)
      expect(node.superseded_by_task_id === null || nodeIds.has(node.superseded_by_task_id)).toBe(true)
    }
    for (const edge of parsed.graph.edges) {
      expect(nodeIds.has(edge.from_task_id)).toBe(true)
      expect(nodeIds.has(edge.to_task_id)).toBe(true)
    }
  })

  it("fails NOT_FOUND when the seed task does not exist", async () => {
    const exit = await runEff(
      Effect.provide(inspectGraphCommand("task_missing"), Layer.merge(dbLayer, silentOutput)),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})
