/**
 * Unit tests for pithos enqueue. Integration coverage lives in test/enqueue-cli.integration.test.ts and test/enqueue-sqlite.integration.test.ts.
 */

import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { enqueueCommand } from "./enqueue.ts"
import { inspectTaskCommand } from "./inspect.ts"
import { parseArgs } from "../cli/args.ts"
import { makeDbServiceTest } from "../layers/db.ts"
import { makeIdServiceTest } from "../layers/ids.ts"
import { makeFsServiceTest } from "../layers/fs.ts"
import { makeOutputServiceSilent } from "../layers/output.ts"

const silentOutput = makeOutputServiceSilent()

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / ID / FS services
// ---------------------------------------------------------------------------

describe("enqueueCommand (unit — fake DB)", () => {
  it("fails VALIDATION_ERROR when --scope is missing", async () => {
    const layer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest([]), makeFsServiceTest(), silentOutput)
    const exit = await runEff(
      Effect.provide(
        enqueueCommand({ scope: undefined, capability: "watch", title: "Test" }),
        layer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --capability is missing", async () => {
    const layer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest([]), makeFsServiceTest(), silentOutput)
    const exit = await runEff(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: undefined, title: "Test" }),
        layer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --title is missing", async () => {
    const layer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest([]), makeFsServiceTest(), silentOutput)
    const exit = await runEff(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "watch", title: undefined }),
        layer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("inspectTaskCommand (unit — fake DB)", () => {
  it("fails NOT_FOUND when task is absent from fake DB", async () => {
    const exit = await runEff(
      Effect.provide(inspectTaskCommand("task_missing"), Layer.merge(makeDbServiceTest(), silentOutput)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. parseArgs — enqueue and inspect task routing
// ---------------------------------------------------------------------------

describe("parseArgs — enqueue", () => {
  it("parses all required flags", async () => {
    const result = await Effect.runPromise(
      parseArgs(["enqueue", "--scope", "global", "--capability", "triage", "--title", "Test"]),
    )
    expect(result).toMatchObject({
      command: "enqueue",
      scope: "global",
      capability: "triage",
      title: "Test",
    })
  })

  it("parses --body-file flag", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "enqueue",
        "--scope",
        "global",
        "--capability",
        "watch",
        "--title",
        "T",
        "--body-file",
        "/tmp/body.md",
      ]),
    )
    expect(result).toMatchObject({ command: "enqueue", bodyFile: "/tmp/body.md" })
  })

  it("parses --body flag", async () => {
    const result = await Effect.runPromise(
      parseArgs(["enqueue", "--scope", "global", "--capability", "watch", "--title", "T", "--body", "inline text"]),
    )
    expect(result).toMatchObject({ command: "enqueue", body: "inline text" })
  })

  it("parses --run and --parent-id flags", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "enqueue",
        "--scope",
        "global",
        "--capability",
        "watch",
        "--title",
        "T",
        "--run",
        "run_abc",
        "--parent-id",
        "task_parent",
      ]),
    )
    expect(result).toMatchObject({ command: "enqueue", run: "run_abc", parentId: "task_parent" })
  })

  it("routes 'enqueue --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["enqueue", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "enqueue" })
  })

  it("returns undefined for optional flags when absent", async () => {
    const result = await Effect.runPromise(
      parseArgs(["enqueue", "--scope", "global", "--capability", "watch", "--title", "T"]),
    )
    expect(result).toMatchObject({
      command: "enqueue",
      body: undefined,
      bodyFile: undefined,
      run: undefined,
      parentId: undefined,
    })
  })
})

describe("parseArgs — inspect task", () => {
  it("parses 'inspect task <id>'", async () => {
    const result = await Effect.runPromise(parseArgs(["inspect", "task", "task_abc"]))
    expect(result).toMatchObject({ command: "inspect:task", id: "task_abc" })
  })

  it("routes 'inspect task --help' to help", async () => {
    const result = await Effect.runPromise(parseArgs(["inspect", "task", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "inspect:task" })
  })
})
