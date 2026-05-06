import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { makeDbServiceTest } from "../layers/db.ts"
import { makeFsServiceTest } from "../layers/fs.ts"
import { makeIdServiceTest } from "../layers/ids.ts"
import { makeOutputServiceSilent } from "../layers/output.ts"
import { supersedeCommand } from "./supersede.ts"

const silentOutput = makeOutputServiceSilent()

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

describe("supersedeCommand (unit — fake DB)", () => {
  const makeLayer = () =>
    Layer.mergeAll(
      makeDbServiceTest(),
      makeIdServiceTest(["task_replacement"]),
      makeFsServiceTest(),
      silentOutput,
    )

  it("fails VALIDATION_ERROR when task id is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        supersedeCommand({ taskId: undefined, run: "run_actor", reason: "replace it" }),
        makeLayer(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --run is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        supersedeCommand({ taskId: "task_old", run: undefined, reason: "replace it" }),
        makeLayer(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --reason is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        supersedeCommand({ taskId: "task_old", run: "run_actor", reason: undefined }),
        makeLayer(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --reason is blank", async () => {
    const exit = await runEff(
      Effect.provide(
        supersedeCommand({ taskId: "task_old", run: "run_actor", reason: "   " }),
        makeLayer(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when both --body and --body-file are supplied", async () => {
    const exit = await runEff(
      Effect.provide(
        supersedeCommand({
          taskId: "task_old",
          run: "run_actor",
          reason: "replace it",
          body: "inline",
          bodyFile: "replacement.md",
        }),
        makeLayer(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails NOT_FOUND when the old task does not exist", async () => {
    const exit = await runEff(
      Effect.provide(
        supersedeCommand({ taskId: "task_missing", run: "run_actor", reason: "replace it" }),
        makeLayer(),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
