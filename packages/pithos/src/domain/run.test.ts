import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { resolveMutatingTaskRunId } from "./run.ts"

describe("resolveMutatingTaskRunId", () => {
  it("uses the explicit --run value when env is unset", async () => {
    const result = await Effect.runPromise(resolveMutatingTaskRunId("run_explicit", undefined))
    expect(result).toBe("run_explicit")
  })

  it("falls back to PITHOS_RUN_ID when --run is omitted", async () => {
    const result = await Effect.runPromise(resolveMutatingTaskRunId(undefined, "run_env"))
    expect(result).toBe("run_env")
  })

  it("returns undefined when neither source is present", async () => {
    const result = await Effect.runPromise(resolveMutatingTaskRunId(undefined, undefined))
    expect(result).toBeUndefined()
  })

  it("fails when --run conflicts with PITHOS_RUN_ID", async () => {
    const exit = await Effect.runPromiseExit(
      resolveMutatingTaskRunId("run_explicit", "run_env"),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
