/**
 * Integration tests for pithos briefingCommand — real SQLite.
 * CLI process smoke tests live in test/briefing-cli.integration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"

import { briefingCommand } from "../src/commands/briefing.ts"
import { enqueueCommand } from "../src/commands/enqueue.ts"
import { runRegisterCommand } from "../src/commands/run.ts"
import { claimCommand } from "../src/commands/claim.ts"
import { completeCommand } from "../src/commands/complete.ts"
import { artifactAddCommand } from "../src/commands/artifact.ts"
import { initCommand } from "../src/commands/init.ts"
import { scopeUpsertCommand } from "../src/commands/scope.ts"
import { makeDbServiceLive } from "../src/layers/db.ts"
import { makeIdServiceTest } from "../src/layers/ids.ts"
import { FsServiceLive } from "../src/layers/fs.ts"
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts"

const silentOutput = makeOutputServiceSilent()

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-briefing-"))
}

describe("briefingCommand (integration — real SQLite)", () => {
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

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const upsertRepoScope = async (pathSuffix: string): Promise<string> => {
    const scopePath = join(tempDir, pathSuffix)
    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(
        scopeUpsertCommand({ kind: "repo", path: scopePath }),
        Layer.merge(dbLayer, out.layer),
      ),
    )

    return (JSON.parse(out.lines()[0]!) as { scope: { id: string } }).scope.id
  }

  const enqueue = async (
    taskId: string,
    opts: {
      capability?: string
      title?: string
      scope?: string
      dependsOn?: readonly string[]
    } = {},
  ): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([taskId]), FsServiceLive, silentOutput)
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({
          scope: opts.scope ?? "global",
          capability: opts.capability ?? "triage",
          title: opts.title ?? `Task ${taskId}`,
          dependsOn: opts.dependsOn,
        }),
        layer,
      ),
    )
    return taskId
  }

  const registerRun = async (runId: string): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([runId]), FsServiceLive, silentOutput)
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: runId }), layer),
    )
    return runId
  }

  const claim = async (
    runId: string,
    opts: { scope?: string; capability?: string } = {},
  ): Promise<number> => {
    const out = makeOutputServiceTest()
    const layer = Layer.mergeAll(dbLayer, out.layer)
    await Effect.runPromise(
      Effect.provide(
        claimCommand({
          run: runId,
          scope: opts.scope ?? "global",
          capability: opts.capability ?? "triage",
          leaseMinutes: 10,
        }),
        layer,
      ),
    )
    return (JSON.parse(out.lines()[0]!) as { task: { fencing_token: number } }).task.fencing_token
  }

  const complete = async (taskId: string, runId: string, token: number): Promise<void> => {
    const layer = Layer.mergeAll(dbLayer, FsServiceLive, silentOutput)
    await Effect.runPromise(Effect.provide(completeCommand({ taskId, run: runId, token }), layer))
  }

  const addArtifact = async (
    artifactId: string,
    opts: { task: string; run: string; kind: string; title: string; body: string },
  ): Promise<void> => {
    const bodyFile = join(tempDir, `${artifactId}.txt`)
    writeFileSync(bodyFile, opts.body)
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([artifactId]), FsServiceLive, silentOutput)
    await Effect.runPromise(
      Effect.provide(
        artifactAddCommand({ task: opts.task, run: opts.run, kind: opts.kind, title: opts.title, bodyFile }),
        layer,
      ),
    )
  }

  const runBriefing = async (): Promise<string> => {
    const out = makeOutputServiceTest()
    await Effect.runPromise(Effect.provide(briefingCommand(), Layer.merge(dbLayer, out.layer)))
    return out.lines().join("\n")
  }

  // ---------------------------------------------------------------------------
  // Structure tests
  // ---------------------------------------------------------------------------

  it("renders all four sections on a fresh DB", async () => {
    const text = await runBriefing()
    expect(text).toContain("## Pandora briefing")
    expect(text).toContain("### Needs Adam")
    expect(text).toContain("### Ready for review")
    expect(text).toContain("### Active")
    expect(text).toContain("#### Ready queued")
    expect(text).toContain("#### Blocked queued")
    expect(text).toContain("#### Claimed / running")
    expect(text).toContain("### Stale / failed")
  })

  // ---------------------------------------------------------------------------
  // Watermark tests
  // ---------------------------------------------------------------------------

  it("includes as_of_event_id: 0 on fresh DB (no events emitted by init)", async () => {
    const text = await runBriefing()
    expect(text).toContain("as_of_event_id: 0")
  })

  it("watermark advances after events accumulate", async () => {
    await enqueue("task_wm_1")
    await enqueue("task_wm_2")
    const text = await runBriefing()
    const match = /as_of_event_id: (\d+)/.exec(text)
    expect(match).toBeTruthy()
    expect(Number(match![1])).toBeGreaterThanOrEqual(2)
  })

  // ---------------------------------------------------------------------------
  // Active section tests
  // ---------------------------------------------------------------------------

  it("shows ready queued task in the Ready queued subsection", async () => {
    await enqueue("task_queued_br", { title: "A queued task" })
    const text = await runBriefing()
    expect(text).toContain("#### Ready queued")
    expect(text).toContain("[queued]")
    expect(text).toContain("A queued task")
    expect(text).toContain("task_queued_br")
  })

  it("lists ready queued tasks before blocked queued tasks before claimed work", async () => {
    const blockerScope = await upsertRepoScope("api")
    await enqueue("task_blocker_br", { scope: blockerScope, title: "API blocker" })
    await enqueue("task_ready_br", { title: "Ready task" })
    await enqueue("task_blocked_br", {
      title: "Blocked task",
      dependsOn: ["task_blocker_br"],
    })
    await registerRun("run_claimed_order")
    await enqueue("task_claimed_br", { title: "Claimed task", capability: "watch" })
    await claim("run_claimed_order", { capability: "watch" })

    const text = await runBriefing()
    const readyIndex = text.indexOf("[queued] `task_ready_br`")
    const blockedIndex = text.indexOf("[queued blocked] `task_blocked_br`")
    const claimedIndex = text.indexOf("[claimed] `task_claimed_br`")

    expect(readyIndex).toBeGreaterThan(-1)
    expect(blockedIndex).toBeGreaterThan(readyIndex)
    expect(claimedIndex).toBeGreaterThan(blockedIndex)
  })

  it("shows blocked queued tasks with all unresolved blocker ids, scopes, and statuses in blocker order", async () => {
    const designScope = await upsertRepoScope("design")
    const apiScope = await upsertRepoScope("api-2")
    await enqueue("task_blocker_a", { scope: designScope, title: "Design blocker" })
    await enqueue("task_blocker_b", { scope: apiScope, title: "API blocker" })
    await enqueue("task_multi_blocked", {
      title: "Blocked by two tasks",
      dependsOn: ["task_blocker_a", "task_blocker_b"],
    })

    const text = await runBriefing()
    expect(text).toContain("#### Blocked queued")
    expect(text).toContain("[queued blocked] `task_multi_blocked`")

    const blockerALine = `blocked by \`task_blocker_a\` (scope: ${designScope}, status: queued)`
    const blockerBLine = `blocked by \`task_blocker_b\` (scope: ${apiScope}, status: queued)`
    const blockerAIndex = text.indexOf(blockerALine)
    const blockerBIndex = text.indexOf(blockerBLine)

    expect(blockerAIndex).toBeGreaterThan(-1)
    expect(blockerBIndex).toBeGreaterThan(blockerAIndex)
  })

  it("shows claimed task in Active section with run reference", async () => {
    await enqueue("task_claim_br", { title: "Claimed task" })
    await registerRun("run_claim_br")
    await claim("run_claim_br")
    const text = await runBriefing()
    expect(text).toContain("[claimed]")
    expect(text).toContain("task_claim_br")
    expect(text).toContain("run_claim_br")
  })

  // ---------------------------------------------------------------------------
  // Ready for review tests
  // ---------------------------------------------------------------------------

  it("shows done task in Ready for review section", async () => {
    await enqueue("task_done_br", { title: "Completed task" })
    await registerRun("run_done_br")
    const token = await claim("run_done_br")
    await complete("task_done_br", "run_done_br", token)
    const text = await runBriefing()
    expect(text).toContain("[done]")
    expect(text).toContain("Completed task")
    expect(text).toContain("task_done_br")
  })

  it("includes worker-completion artifact summary under done task", async () => {
    await enqueue("task_art_br", { title: "Artifact task" })
    await registerRun("run_art_br")
    const token = await claim("run_art_br")
    await complete("task_art_br", "run_art_br", token)
    await addArtifact("artifact_art_br", {
      task: "task_art_br",
      run: "run_art_br",
      kind: "worker-completion",
      title: "Worker report",
      body: "Task complete. All tests pass.",
    })

    const text = await runBriefing()
    // Done task section
    expect(text).toContain("[done]")
    expect(text).toContain("Artifact task")
    // Artifact nested under the task
    expect(text).toContain("worker-completion")
    expect(text).toContain("Worker report")
  })

  // ---------------------------------------------------------------------------
  // Needs Adam tests
  // ---------------------------------------------------------------------------

  it("shows dead_letter task in Needs Adam section", async () => {
    await enqueue("task_dl_br", { title: "Dead letter task" })
    // Force to dead_letter directly via SQL
    const db = new Database(dbPath)
    db.prepare(`UPDATE tasks SET status = 'dead_letter', attempts = 3, max_attempts = 3 WHERE id = 'task_dl_br'`).run()
    db.close()

    const text = await runBriefing()
    expect(text).toContain("[dead_letter]")
    expect(text).toContain("task_dl_br")
    expect(text).toContain("Dead letter task")
  })

  // ---------------------------------------------------------------------------
  // Stale / failed tests
  // ---------------------------------------------------------------------------

  it("shows stale run (explicitly marked) in Stale / failed section", async () => {
    await registerRun("run_stale_br")
    const db = new Database(dbPath)
    db.prepare(`UPDATE runs SET status = 'stale' WHERE id = 'run_stale_br'`).run()
    db.close()

    const text = await runBriefing()
    expect(text).toContain("[stale run]")
    expect(text).toContain("run_stale_br")
    expect(text).toContain("envy")
  })

  it("shows active run with expired heartbeat (stale-by-age) in Stale / failed section", async () => {
    await registerRun("run_hb_expired")
    // Back-date heartbeat to 20 minutes ago — past the 15-minute threshold.
    const db = new Database(dbPath)
    db.prepare(`UPDATE runs SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-20 minutes')) WHERE id = 'run_hb_expired'`).run()
    db.close()

    const text = await runBriefing()
    expect(text).toContain("[stale run]")
    expect(text).toContain("run_hb_expired")
  })

  it("does not show active run with fresh heartbeat in Stale / failed", async () => {
    await registerRun("run_fresh_hb")
    // Only 5 minutes old — well within the 15-minute threshold.
    const db = new Database(dbPath)
    db.prepare(`UPDATE runs SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-5 minutes')) WHERE id = 'run_fresh_hb'`).run()
    db.close()

    const text = await runBriefing()
    expect(text).not.toContain("run_fresh_hb")
  })

  it("shows failed task in Stale / failed section", async () => {
    await enqueue("task_fail_br", { title: "Failed task" })
    const db = new Database(dbPath)
    db.prepare(`UPDATE tasks SET status = 'failed' WHERE id = 'task_fail_br'`).run()
    db.close()

    const text = await runBriefing()
    expect(text).toContain("[failed]")
    expect(text).toContain("task_fail_br")
  })

  // ---------------------------------------------------------------------------
  // Exclusion tests
  // ---------------------------------------------------------------------------

  it("does not show cancelled tasks", async () => {
    await enqueue("task_cancel_br", { title: "Cancelled task" })
    const db = new Database(dbPath)
    db.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = 'task_cancel_br'`).run()
    db.close()

    const text = await runBriefing()
    expect(text).not.toContain("task_cancel_br")
    expect(text).not.toContain("Cancelled task")
  })

  // ---------------------------------------------------------------------------
  // Validation tests
  // ---------------------------------------------------------------------------

  it("fails with code VALIDATION_ERROR for invalid --agent", async () => {
    const out = makeOutputServiceTest()
    const exit = await Effect.runPromiseExit(
      Effect.provide(briefingCommand({ agent: "bogus" }), Layer.merge(dbLayer, out.layer)),
    )
    const { Exit } = await import("effect")
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
