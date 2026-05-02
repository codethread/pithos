/**
 * Unit tests for pithos complete. Integration coverage lives in test/complete.integration.test.ts.
 */

import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { completeCommand } from "./complete.ts"
import { failCommand } from "./fail.ts"
import { parseArgs } from "../cli/args.ts"
import { makeDbServiceTest } from "../layers/db.ts"
import { makeFsServiceTest } from "../layers/fs.ts"
import { makeOutputServiceSilent } from "../layers/output.ts"

const silentOutput = makeOutputServiceSilent()

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / validation only
// ---------------------------------------------------------------------------

describe("completeCommand (unit — fake DB)", () => {
  const fakeLayer = Layer.mergeAll(makeDbServiceTest(), makeFsServiceTest(), silentOutput)

  it("fails VALIDATION_ERROR when task id is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId: undefined, run: "run_abc", token: 1 }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --run is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId: "task_abc", run: undefined, token: 1 }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --token is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId: "task_abc", run: "run_abc", token: undefined }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --token is NaN", async () => {
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId: "task_abc", run: "run_abc", token: NaN }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --result-file is not valid JSON", async () => {
    const fs = makeFsServiceTest(new Map([["/tmp/bad.json", "not json {"]]))
    const layer = Layer.mergeAll(makeDbServiceTest(), fs, silentOutput)
    const exit = await runEff(
      Effect.provide(
        completeCommand({ taskId: "task_abc", run: "run_abc", token: 1, resultFile: "/tmp/bad.json" }),
        layer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("failCommand (unit — fake DB)", () => {
  it("fails VALIDATION_ERROR when task id is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        failCommand({ taskId: undefined, run: "run_abc", token: 1 }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --run is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        failCommand({ taskId: "task_abc", run: undefined, token: 1 }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --token is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        failCommand({ taskId: "task_abc", run: "run_abc", token: undefined }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --token is NaN", async () => {
    const exit = await runEff(
      Effect.provide(
        failCommand({ taskId: "task_abc", run: "run_abc", token: NaN }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. parseArgs — complete/fail routing
// ---------------------------------------------------------------------------

describe("parseArgs — complete", () => {
  it("parses required flags", async () => {
    const result = await Effect.runPromise(
      parseArgs(["complete", "task_abc", "--run", "run_xyz", "--token", "1"]),
    )
    expect(result).toMatchObject({
      command: "complete",
      taskId: "task_abc",
      run: "run_xyz",
      token: 1,
      resultFile: undefined,
    })
  })

  it("parses --result-file flag", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "complete",
        "task_abc",
        "--run",
        "run_xyz",
        "--token",
        "2",
        "--result-file",
        "/tmp/res.json",
      ]),
    )
    expect(result).toMatchObject({
      command: "complete",
      taskId: "task_abc",
      token: 2,
      resultFile: "/tmp/res.json",
    })
  })

  it("routes 'complete --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["complete", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "complete" })
  })

  it("parses --token as a number", async () => {
    const result = await Effect.runPromise(
      parseArgs(["complete", "task_abc", "--run", "run_xyz", "--token", "42"]),
    )
    expect(result).toMatchObject({ command: "complete", token: 42 })
  })
})

describe("parseArgs — fail", () => {
  it("parses required flags", async () => {
    const result = await Effect.runPromise(
      parseArgs(["fail", "task_abc", "--run", "run_xyz", "--token", "1"]),
    )
    expect(result).toMatchObject({
      command: "fail",
      taskId: "task_abc",
      run: "run_xyz",
      token: 1,
      reason: undefined,
    })
  })

  it("parses --reason flag", async () => {
    const result = await Effect.runPromise(
      parseArgs(["fail", "task_abc", "--run", "run_xyz", "--token", "1", "--reason", "timeout"]),
    )
    expect(result).toMatchObject({
      command: "fail",
      taskId: "task_abc",
      reason: "timeout",
    })
  })

  it("routes 'fail --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["fail", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "fail" })
  })
})
