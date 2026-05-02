/**
 * Unit tests for pithos sweep. Integration coverage lives in
 * test/sweep-cli.integration.test.ts and test/sweep-sqlite.integration.test.ts.
 */

import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { sweepCommand } from "./sweep.ts"
import { makeDbServiceTest } from "../layers/db.ts"
import { makeOutputServiceSilent } from "../layers/output.ts"

const silentOutput = makeOutputServiceSilent()

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// Unit — validation only (fake DB)
// ---------------------------------------------------------------------------

describe("sweepCommand (unit — fake DB)", () => {
  const fakeLayer = Layer.merge(makeDbServiceTest(), silentOutput)

  it("succeeds with zero counts when DB is empty", async () => {
    const exit = await runEff(Effect.provide(sweepCommand(), fakeLayer))
    // fake DB returns empty results so sweep should succeed with zeros
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --lease-grace-seconds is negative", async () => {
    const exit = await runEff(
      Effect.provide(sweepCommand({ leaseGraceSeconds: -1 }), fakeLayer),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --run-stale-minutes is zero", async () => {
    const exit = await runEff(
      Effect.provide(sweepCommand({ runStaleMinutes: 0 }), fakeLayer),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --run-stale-minutes is negative", async () => {
    const exit = await runEff(
      Effect.provide(sweepCommand({ runStaleMinutes: -5 }), fakeLayer),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("accepts --lease-grace-seconds of 0 (default)", async () => {
    const exit = await runEff(
      Effect.provide(sweepCommand({ leaseGraceSeconds: 0 }), fakeLayer),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

