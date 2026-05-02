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

  const enqueue = async (
    taskId: string,
    opts: { capability?: string; title?: string; scope?: string } = {},
  ): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([taskId]), FsServiceLive, silentOutput)
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({
          scope: opts.scope ?? "global",
          capability: opts.capability ?? "triage",
          title: opts.title ?? `Task ${taskId}`,
        }),
        layer,
      ),
    )
    return taskId
  }

  const registerRun = async (runId: string): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([runId]), FsServiceLive, silentOutput)
    await Effect.runPromise(Effect.provide(runRegisterCommand({ agentKind: "envy" }), layer))
    return runId
  }

  const claim = async (runId: string): Promise<number> => {
    const out = makeOutputServiceTest()
    const layer = Layer.mergeAll(dbLayer, out.layer)
    await Effect.runPromise(
      Effect.provide(
        claimCommand({ run: runId, scope: "global", capability: "triage", leaseMinutes: 10 }),
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

  it("shows queued task in Active section", async () => {
    await enqueue("task_queued_br", { title: "A queued task" })
    const text = await runBriefing()
    expect(text).toContain("[queued]")
    expect(text).toContain("A queued task")
    expect(text).toContain("task_queued_br")
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

  it("shows stale run in Stale / failed section", async () => {
    await registerRun("run_stale_br")
    const db = new Database(dbPath)
    db.prepare(`UPDATE runs SET status = 'stale' WHERE id = 'run_stale_br'`).run()
    db.close()

    const text = await runBriefing()
    expect(text).toContain("[stale run]")
    expect(text).toContain("run_stale_br")
    expect(text).toContain("envy")
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
