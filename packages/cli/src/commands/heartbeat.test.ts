/**
 * Unit tests for pithos heartbeat. Integration coverage lives in test/heartbeat-*.integration.test.ts.
 */

import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { heartbeatCommand } from "./heartbeat.ts"
import { makeDbServiceTest } from "../layers/db.ts"
import { makeOutputServiceSilent } from "../layers/output.ts"

const silentOutput = makeOutputServiceSilent()

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / validation only
// ---------------------------------------------------------------------------

describe("heartbeatCommand (unit — fake DB)", () => {
  it("fails VALIDATION_ERROR when --run is missing", async () => {
    const exit = await runEff(
      Effect.provide(heartbeatCommand({ run: undefined }), Layer.merge(makeDbServiceTest(), silentOutput)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --task is given without --token", async () => {
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: "run_abc", task: "task_xyz", token: undefined }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --token is NaN", async () => {
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: "run_abc", task: "task_xyz", token: NaN }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --throttle-seconds is NaN", async () => {
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: "run_abc", throttleSeconds: NaN }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --throttle-seconds is negative", async () => {
    const exit = await runEff(
      Effect.provide(
        heartbeatCommand({ run: "run_abc", throttleSeconds: -5 }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

