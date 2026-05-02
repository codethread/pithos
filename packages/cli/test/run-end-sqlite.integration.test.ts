/**
 * Integration tests for pithos runEndCommand — real SQLite. Unit coverage lives in src/commands/run.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"

import { runRegisterCommand, runEndCommand } from "../src/commands/run.ts"
import { makeDbServiceLive } from "../src/layers/db.ts"
import { makeIdServiceTest } from "../src/layers/ids.ts"
import { initCommand } from "../src/commands/init.ts"
import { makeOutputServiceSilent } from "../src/layers/output.ts"

const silentOutput = makeOutputServiceSilent()

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-run-"))
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

describe("runEndCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    dbLayer = makeDbServiceLive(dbPath)
    await Effect.runPromise(Effect.provide(initCommand, Layer.merge(dbLayer, silentOutput)))
    // Seed a run to end
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([]), silentOutput)
    await Effect.runPromise(
      Effect.provide(
        runRegisterCommand({ agentKind: "envy", run: "run_to_end" }),
        layer,
      ),
    )
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("sets ended_at on a run when ended", async () => {
    await Effect.runPromise(
      Effect.provide(
        runEndCommand({ run: "run_to_end", status: "ended" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT status, ended_at FROM runs WHERE id = 'run_to_end'")
      .get() as { status: string; ended_at: string | null } | undefined
    db.close()

    expect(row?.status).toBe("ended")
    expect(row?.ended_at).not.toBeNull()
  })

  it("appends a run.ended lifecycle event", async () => {
    await Effect.runPromise(
      Effect.provide(
        runEndCommand({ run: "run_to_end", status: "ended", summary: "completed" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const events = db
      .prepare("SELECT type, payload_json FROM events WHERE type = 'run.ended'")
      .all() as { type: string; payload_json: string }[]
    db.close()

    expect(events).toHaveLength(1)
    const [endedEvent] = events
    expect(endedEvent?.type).toBe("run.ended")
    const payload = JSON.parse(endedEvent?.payload_json ?? "{}") as {
      status: string
      summary: string
    }
    expect(payload.status).toBe("ended")
    expect(payload.summary).toBe("completed")
  })

  it("stores summary in last_summary", async () => {
    await Effect.runPromise(
      Effect.provide(
        runEndCommand({ run: "run_to_end", status: "failed", summary: "crashed" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const summaryRow = db
      .prepare("SELECT last_summary, status FROM runs WHERE id = 'run_to_end'")
      .get() as { last_summary: string; status: string } | undefined
    db.close()

    expect(summaryRow?.last_summary).toBe("crashed")
    expect(summaryRow?.status).toBe("failed")
  })

  it("fails NOT_FOUND for non-existent run", async () => {
    const exit = await runEff(
      Effect.provide(
        runEndCommand({ run: "run_ghost", status: "ended" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("is idempotent — ending an already-ended run returns success without re-appending an event", async () => {
    await Effect.runPromise(
      Effect.provide(runEndCommand({ run: "run_to_end", status: "ended" }), Layer.merge(dbLayer, silentOutput)),
    )

    // Second call on an already-ended run
    const exit = await runEff(
      Effect.provide(runEndCommand({ run: "run_to_end", status: "ended" }), Layer.merge(dbLayer, silentOutput)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)

    // Exactly one run.ended event total
    const db = new Database(dbPath)
    const events = db
      .prepare("SELECT type FROM events WHERE type = 'run.ended'")
      .all() as { type: string }[]
    db.close()
    expect(events).toHaveLength(1)
  })

  it("supports cancellation status", async () => {
    await Effect.runPromise(
      Effect.provide(
        runEndCommand({ run: "run_to_end", status: "cancelled" }),
        Layer.merge(dbLayer, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const cancelRow = db
      .prepare("SELECT status FROM runs WHERE id = 'run_to_end'")
      .get() as { status: string } | undefined
    db.close()

    expect(cancelRow?.status).toBe("cancelled")
  })
})
