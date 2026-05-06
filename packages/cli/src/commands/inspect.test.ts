import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import {
  decodeInspectGraphSelector,
  inspectGraphCommand,
} from "./inspect.ts"
import { makeDbServiceTest } from "../layers/db.ts"
import { makeOutputServiceSilent, makeOutputServiceTest } from "../layers/output.ts"

const silentOutput = makeOutputServiceSilent()

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

describe("decodeInspectGraphSelector", () => {
  it("fails VALIDATION_ERROR when no selector is provided", async () => {
    const exit = await runEff(
      decodeInspectGraphSelector({ taskId: undefined, scopeId: undefined, live: false }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when multiple selectors are provided", async () => {
    const exit = await runEff(
      decodeInspectGraphSelector({ taskId: "task_a", scopeId: "scope_a", live: false }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("inspectGraphCommand (unit — fake DB)", () => {
  it("fails NOT_FOUND when the seed task is absent from the DB", async () => {
    const exit = await runEff(
      Effect.provide(
        inspectGraphCommand({ kind: "task", value: "task_missing" }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails NOT_FOUND when the scope selector does not exist", async () => {
    const exit = await runEff(
      Effect.provide(
        inspectGraphCommand({ kind: "scope", value: "scope_missing" }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("returns an empty graph for --live when there are no non-cancelled tasks", async () => {
    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(
        inspectGraphCommand({ kind: "live" }),
        Layer.merge(makeDbServiceTest(), out.layer),
      ),
    )

    expect(out.lines()).toEqual([
      JSON.stringify({
        ok: true,
        graph: {
          selector: { kind: "live" },
          nodes: [],
          edges: [],
        },
      }),
    ])
  })
})
