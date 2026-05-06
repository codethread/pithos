import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { inspectGraphCommand } from "./inspect.ts"
import { makeDbServiceTest } from "../layers/db.ts"
import { makeOutputServiceSilent } from "../layers/output.ts"

const silentOutput = makeOutputServiceSilent()

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

describe("inspectGraphCommand (unit — fake DB)", () => {
  it("fails NOT_FOUND when the seed task is absent from the DB", async () => {
    const exit = await runEff(
      Effect.provide(inspectGraphCommand("task_missing"), Layer.merge(makeDbServiceTest(), silentOutput)),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})
