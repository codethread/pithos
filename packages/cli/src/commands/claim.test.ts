/**
 * Unit tests for pithos claim. Integration coverage lives in test/claim.integration.test.ts.
 */

import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { claimCommand } from "./claim.ts"
import { parseArgs } from "../cli/args.ts"
import { makeDbServiceTest } from "../layers/db.ts"
import { makeOutputServiceSilent } from "../layers/output.ts"

const silentOutput = makeOutputServiceSilent()

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / validation only
// ---------------------------------------------------------------------------

describe("claimCommand (unit — fake DB)", () => {
  it("fails VALIDATION_ERROR when --run is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        claimCommand({ run: undefined, scope: "global", capability: "triage" }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --scope is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        claimCommand({ run: "run_abc", scope: undefined, capability: "triage" }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --capability is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        claimCommand({ run: "run_abc", scope: "global", capability: undefined }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --lease-minutes is NaN (e.g. 'abc')", async () => {
    const exit = await runEff(
      Effect.provide(
        claimCommand({ run: "run_abc", scope: "global", capability: "triage", leaseMinutes: NaN }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --lease-minutes is zero", async () => {
    const exit = await runEff(
      Effect.provide(
        claimCommand({ run: "run_abc", scope: "global", capability: "triage", leaseMinutes: 0 }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. parseArgs — claim routing
// ---------------------------------------------------------------------------

describe("parseArgs — claim", () => {
  it("parses required flags", async () => {
    const result = await Effect.runPromise(
      parseArgs(["claim", "--run", "run_abc", "--scope", "global", "--capability", "triage"]),
    )
    expect(result).toMatchObject({
      command: "claim",
      run: "run_abc",
      scope: "global",
      capability: "triage",
      leaseMinutes: undefined,
    })
  })

  it("parses --lease-minutes as a number", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "claim",
        "--run",
        "run_abc",
        "--scope",
        "global",
        "--capability",
        "triage",
        "--lease-minutes",
        "20",
      ]),
    )
    expect(result).toMatchObject({ command: "claim", leaseMinutes: 20 })
  })

  it("routes 'claim --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["claim", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "claim" })
  })

  it("returns undefined for optional flags when absent", async () => {
    const result = await Effect.runPromise(
      parseArgs(["claim", "--run", "run_abc", "--scope", "global", "--capability", "triage"]),
    )
    expect(result).toMatchObject({ command: "claim", leaseMinutes: undefined })
  })
})
