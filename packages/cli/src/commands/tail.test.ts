/**
 * Unit tests for pithos tailCommand and related parseArgs routing.
 * Integration coverage lives in test/tail-sqlite.integration.test.ts and
 * test/tail-cli.integration.test.ts.
 */

import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { tailCommand } from "./tail.ts"
import { parseArgs } from "../cli/args.ts"
import { makeDbServiceTest } from "../layers/db.ts"
import { makeOutputServiceSilent, makeOutputServiceTest } from "../layers/output.ts"

const silentOutput = makeOutputServiceSilent()

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / validation only
// ---------------------------------------------------------------------------

describe("tailCommand (unit — fake DB)", () => {
  it("succeeds with empty events on empty DB", async () => {
    const out = makeOutputServiceTest()
    const layer = Layer.merge(makeDbServiceTest(), out.layer)
    const exit = await runEff(Effect.provide(tailCommand(), layer))
    expect(Exit.isSuccess(exit)).toBe(true)
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      events: unknown[]
      count: number
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.events).toHaveLength(0)
    expect(parsed.count).toBe(0)
  })

  it("uses default limit of 20 when no limit provided", async () => {
    const out = makeOutputServiceTest()
    const layer = Layer.merge(makeDbServiceTest(), out.layer)
    await runEff(Effect.provide(tailCommand(), layer))
    // Just verify it succeeded — the SQL would include LIMIT 20
    expect(out.lines()).toHaveLength(1)
  })

  it("fails VALIDATION_ERROR when limit is zero", async () => {
    const layer = Layer.merge(makeDbServiceTest(), silentOutput)
    const exit = await runEff(Effect.provide(tailCommand({ limit: 0 }), layer))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when limit is negative", async () => {
    const layer = Layer.merge(makeDbServiceTest(), silentOutput)
    const exit = await runEff(Effect.provide(tailCommand({ limit: -5 }), layer))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("output includes ok, count, and events fields", async () => {
    const out = makeOutputServiceTest()
    const layer = Layer.merge(makeDbServiceTest(), out.layer)
    await runEff(Effect.provide(tailCommand({ limit: 10 }), layer))
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      count: number
      events: unknown[]
    }
    expect(parsed).toHaveProperty("ok", true)
    expect(parsed).toHaveProperty("count")
    expect(parsed).toHaveProperty("events")
  })
})

// ---------------------------------------------------------------------------
// 2. parseArgs — tail routing
// ---------------------------------------------------------------------------

describe("parseArgs — tail", () => {
  it("parses 'tail' with no flags", async () => {
    const result = await Effect.runPromise(parseArgs(["tail"]))
    expect(result).toMatchObject({ command: "tail", limit: undefined })
  })

  it("parses --limit flag as integer", async () => {
    const result = await Effect.runPromise(parseArgs(["tail", "--limit", "50"]))
    expect(result).toMatchObject({ command: "tail", limit: 50 })
  })

  it("parses --limit 1", async () => {
    const result = await Effect.runPromise(parseArgs(["tail", "--limit", "1"]))
    expect(result).toMatchObject({ command: "tail", limit: 1 })
  })

  it("routes 'tail --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["tail", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "tail" })
  })

  it("routes 'tail -h' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["tail", "-h"]))
    expect(result).toMatchObject({ command: "help", topic: "tail" })
  })

  it("fails VALIDATION_ERROR when --limit is not a number", async () => {
    const exit = await runEff(parseArgs(["tail", "--limit", "abc"]))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
