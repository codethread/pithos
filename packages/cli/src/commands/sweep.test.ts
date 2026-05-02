/**
 * Unit tests for pithos sweep. Integration coverage lives in
 * test/sweep-cli.integration.test.ts and test/sweep-sqlite.integration.test.ts.
 */

import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { sweepCommand } from "./sweep.ts"
import { parseArgs } from "../cli/args.ts"
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

// ---------------------------------------------------------------------------
// parseArgs — sweep routing
// ---------------------------------------------------------------------------

describe("parseArgs — sweep", () => {
  it("parses bare 'sweep' with defaults (undefined flags)", async () => {
    const result = await Effect.runPromise(parseArgs(["sweep"]))
    expect(result).toMatchObject({
      command: "sweep",
      leaseGraceSeconds: undefined,
      runStaleMinutes: undefined,
    })
  })

  it("parses --lease-grace-seconds", async () => {
    const result = await Effect.runPromise(
      parseArgs(["sweep", "--lease-grace-seconds", "30"]),
    )
    expect(result).toMatchObject({ command: "sweep", leaseGraceSeconds: 30 })
  })

  it("parses --run-stale-minutes", async () => {
    const result = await Effect.runPromise(
      parseArgs(["sweep", "--run-stale-minutes", "20"]),
    )
    expect(result).toMatchObject({ command: "sweep", runStaleMinutes: 20 })
  })

  it("parses both flags together", async () => {
    const result = await Effect.runPromise(
      parseArgs(["sweep", "--lease-grace-seconds", "10", "--run-stale-minutes", "5"]),
    )
    expect(result).toMatchObject({
      command: "sweep",
      leaseGraceSeconds: 10,
      runStaleMinutes: 5,
    })
  })

  it("routes 'sweep --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["sweep", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "sweep" })
  })

  it("fails VALIDATION_ERROR when --lease-grace-seconds is not a number", async () => {
    const exit = await Effect.runPromiseExit(
      parseArgs(["sweep", "--lease-grace-seconds", "abc"]),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --run-stale-minutes is not a number", async () => {
    const exit = await Effect.runPromiseExit(
      parseArgs(["sweep", "--run-stale-minutes", "xyz"]),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
