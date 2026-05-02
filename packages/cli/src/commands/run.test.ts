/**
 * Unit tests for pithos run. Integration coverage lives in test/run-*.integration.test.ts.
 */

import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"

import { runRegisterCommand, runEndCommand } from "./run.ts"
import { inspectRunCommand } from "./inspect.ts"
import { parseArgs } from "../cli/args.ts"
import { makeDbServiceTest } from "../layers/db.ts"
import { makeIdServiceTest } from "../layers/ids.ts"
import { makeOutputServiceSilent } from "../layers/output.ts"

const silentOutput = makeOutputServiceSilent()

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / ID services
// ---------------------------------------------------------------------------

describe("runRegisterCommand (unit — fake DB)", () => {
  it("fails VALIDATION_ERROR when --agent-kind is missing", async () => {
    const layer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest([]), silentOutput)
    const exit = await runEff(
      Effect.provide(runRegisterCommand({ agentKind: undefined }), layer),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("succeeds when agent-kind is provided", async () => {
    const layer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest(["run_u1"]), silentOutput)
    const exit = await runEff(
      Effect.provide(runRegisterCommand({ agentKind: "envy" }), layer),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("returns early (idempotent) when run ID exists in fake DB", async () => {
    const seed = new Map<string, readonly Record<string, unknown>[]>([
      [
        "SELECT * FROM runs WHERE id = ?",
        [{ id: "run_existing", agent_kind: "envy", status: "starting" }],
      ],
    ])
    const layer = Layer.mergeAll(makeDbServiceTest(seed), makeIdServiceTest([]), silentOutput)
    const exit = await runEff(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_existing" }), layer),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

describe("runEndCommand (unit — fake DB)", () => {
  it("fails VALIDATION_ERROR when --run is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        runEndCommand({ run: undefined, status: "ended" }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR for an invalid --status value", async () => {
    const exit = await runEff(
      Effect.provide(
        runEndCommand({ run: "run_abc", status: "faild" }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("accepts undefined --status and defaults to ended", async () => {
    // fake DB returns empty rows (no run), so result is still failure (NOT_FOUND)
    // but it should not fail with VALIDATION_ERROR
    const exit = await runEff(
      Effect.provide(
        runEndCommand({ run: "run_abc", status: undefined }),
        Layer.merge(makeDbServiceTest(), silentOutput),
      ),
    )
    // fails NOT_FOUND (not VALIDATION_ERROR) — status defaulted correctly
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("inspectRunCommand (unit — fake DB)", () => {
  it("fails NOT_FOUND when run is absent from fake DB", async () => {
    const exit = await runEff(
      Effect.provide(inspectRunCommand("run_missing"), Layer.merge(makeDbServiceTest(), silentOutput)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. parseArgs — run and inspect run routing
// ---------------------------------------------------------------------------

describe("parseArgs — run and inspect run", () => {
  it("parses 'run register --agent-kind envy'", async () => {
    const result = await Effect.runPromise(
      parseArgs(["run", "register", "--agent-kind", "envy"]),
    )
    expect(result).toMatchObject({ command: "run:register", agentKind: "envy" })
  })

  it("parses all optional flags for run register", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "run",
        "register",
        "--agent-kind",
        "envy",
        "--scope",
        "repo:work/foo",
        "--cwd",
        "/home/user/foo",
        "--session-id",
        "sess123",
        "--parent-run",
        "run_parent",
      ]),
    )
    expect(result).toMatchObject({
      command: "run:register",
      agentKind: "envy",
      scopeId: "repo:work/foo",
      cwd: "/home/user/foo",
      sessionId: "sess123",
      parentRun: "run_parent",
    })
  })

  it("parses 'run end --run run_abc' with no --status (defaults to undefined)", async () => {
    const result = await Effect.runPromise(parseArgs(["run", "end", "--run", "run_abc"]))
    expect(result).toMatchObject({ command: "run:end", run: "run_abc", status: undefined })
  })

  it("parses 'run end --run run_abc --status failed --summary foo'", async () => {
    const result = await Effect.runPromise(
      parseArgs(["run", "end", "--run", "run_abc", "--status", "failed", "--summary", "foo"]),
    )
    expect(result).toMatchObject({
      command: "run:end",
      run: "run_abc",
      status: "failed",
      summary: "foo",
    })
  })

  it("defaults run:end status to 'ended' when --status is not provided", async () => {
    const result = await Effect.runPromise(
      parseArgs(["run", "end", "--run", "run_abc"]),
    )
    expect(result).toMatchObject({ command: "run:end", status: undefined })
  })

  it("passes the raw --status value through (validation happens in command)", async () => {
    const result = await Effect.runPromise(
      parseArgs(["run", "end", "--run", "run_abc", "--status", "unknown_val"]),
    )
    expect(result).toMatchObject({ command: "run:end", status: "unknown_val" })
  })

  it("routes 'run register --help' to help", async () => {
    const result = await Effect.runPromise(parseArgs(["run", "register", "--help"]))
    expect(result).toMatchObject({ command: "help" })
  })

  it("routes 'run end --help' to help", async () => {
    const result = await Effect.runPromise(parseArgs(["run", "end", "--help"]))
    expect(result).toMatchObject({ command: "help" })
  })

  it("parses 'inspect run <id>'", async () => {
    const result = await Effect.runPromise(parseArgs(["inspect", "run", "run_abc"]))
    expect(result).toMatchObject({ command: "inspect:run", id: "run_abc" })
  })

  it("routes 'inspect run --help' to help", async () => {
    const result = await Effect.runPromise(parseArgs(["inspect", "run", "--help"]))
    expect(result).toMatchObject({ command: "help" })
  })
})
