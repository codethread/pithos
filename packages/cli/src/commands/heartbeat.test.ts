/**
 * Unit tests for pithos heartbeat. Integration coverage lives in test/heartbeat-*.integration.test.ts.
 */

import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { heartbeatCommand } from "./heartbeat.ts"
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

// ---------------------------------------------------------------------------
// 3. parseArgs — heartbeat routing
// ---------------------------------------------------------------------------

describe("parseArgs — heartbeat", () => {
  it("parses required --run flag", async () => {
    const result = await Effect.runPromise(
      parseArgs(["heartbeat", "--run", "run_abc"]),
    )
    expect(result).toMatchObject({ command: "heartbeat", run: "run_abc" })
  })

  it("parses all optional flags", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "heartbeat",
        "--run",
        "run_abc",
        "--task",
        "task_xyz",
        "--token",
        "3",
        "--hook",
        "PreToolUse",
        "--throttle-seconds",
        "60",
      ]),
    )
    expect(result).toMatchObject({
      command: "heartbeat",
      run: "run_abc",
      task: "task_xyz",
      token: 3,
      hook: "PreToolUse",
      throttleSeconds: 60,
    })
  })

  it("routes 'heartbeat --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["heartbeat", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "heartbeat" })
  })

  it("returns undefined for optional flags when absent", async () => {
    const result = await Effect.runPromise(
      parseArgs(["heartbeat", "--run", "run_abc"]),
    )
    expect(result).toMatchObject({
      command: "heartbeat",
      task: undefined,
      token: undefined,
      hook: undefined,
      throttleSeconds: undefined,
    })
  })
})
