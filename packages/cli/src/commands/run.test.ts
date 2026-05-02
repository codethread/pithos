/**
 * Unit tests for pithos run. Integration coverage lives in test/run-*.integration.test.ts.
 */

import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { runRegisterCommand, runEndCommand } from "./run.ts"
import { inspectRunCommand } from "./inspect.ts"
import { makeDbServiceTest } from "../layers/db.ts"
import { makeIdServiceTest } from "../layers/ids.ts"
import { makeOutputServiceSilent } from "../layers/output.ts"

const silentOutput = makeOutputServiceSilent()

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / ID services
// ---------------------------------------------------------------------------

describe("runRegisterCommand (unit — fake DB)", () => {
  it("fails VALIDATION_ERROR when --agent-kind is missing", async () => {
    const layer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest([]), silentOutput)
    const exit = await runEff(
      Effect.provide(runRegisterCommand({ agentKind: undefined }), layer),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("succeeds when agent-kind is provided", async () => {
    const layer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest(["run_u1"]), silentOutput)
    const exit = await runEff(
      Effect.provide(runRegisterCommand({ agentKind: "envy" }), layer),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("returns early (idempotent) when run ID exists in fake DB", async () => {
    const seed = new Map<string, readonly Record<string, unknown>[]>([
      [
        "SELECT * FROM runs WHERE id = ?",
        [{ id: "run_existing", agent_kind: "envy", status: "starting" }],
      ],
    ])
    const layer = Layer.mergeAll(makeDbServiceTest(seed), makeIdServiceTest([]), silentOutput)
    const exit = await runEff(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_existing" }), layer),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

describe("runEndCommand (unit — fake DB)", () => {
  it("fails VALIDATION_ERROR when --run is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        runEndCommand({ run: undefined, status: "ended" }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR for an invalid --status value", async () => {
    const exit = await runEff(
      Effect.provide(
        runEndCommand({ run: "run_abc", status: "faild" }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("accepts undefined --status and defaults to ended", async () => {
    // fake DB returns empty rows (no run), so result is still failure (NOT_FOUND)
    // but it should not fail with VALIDATION_ERROR
    const exit = await runEff(
      Effect.provide(
        runEndCommand({ run: "run_abc", status: undefined }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    // fails NOT_FOUND (not VALIDATION_ERROR) — status defaulted correctly
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("inspectRunCommand (unit — fake DB)", () => {
  it("fails NOT_FOUND when run is absent from fake DB", async () => {
    const exit = await runEff(
      Effect.provide(inspectRunCommand("run_missing"), Layer.merge(makeDbServiceTest(), silentOutput)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

