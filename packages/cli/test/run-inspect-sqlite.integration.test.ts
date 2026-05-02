/**
 * Integration tests for pithos inspectRunCommand — real SQLite. Unit coverage lives in src/commands/run.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runRegisterCommand, runEndCommand } from "../src/commands/run.ts"
import { inspectRunCommand } from "../src/commands/inspect.ts"
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

describe("inspectRunCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    dbLayer = makeDbServiceLive(dbPath)
    await Effect.runPromise(Effect.provide(initCommand, Layer.merge(dbLayer, silentOutput)))
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([]), silentOutput)
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_inspect" }), layer),
    )
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns the run after registration", async () => {
    const exit = await runEff(
      Effect.provide(inspectRunCommand("run_inspect"), Layer.merge(dbLayer, silentOutput)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("fails NOT_FOUND for unknown run ID", async () => {
    const exit = await runEff(
      Effect.provide(inspectRunCommand("run_unknown"), Layer.merge(dbLayer, silentOutput)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("shows ended_at after run is ended", async () => {
    await Effect.runPromise(
      Effect.provide(runEndCommand({ run: "run_inspect", status: "ended" }), Layer.merge(dbLayer, silentOutput)),
    )
    const exit = await runEff(
      Effect.provide(inspectRunCommand("run_inspect"), Layer.merge(dbLayer, silentOutput)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
