import { describe, it, expect } from "vitest"
import { Effect, Exit, Cause, Layer } from "effect"
import { parseArgs } from "../src/cli/args.ts"
import { dispatch } from "../src/cli/dispatch.ts"
import { VERSION } from "../src/version.ts"
import { makeDbServiceTest } from "../src/layers/db.ts"
import { makeIdServiceTest } from "../src/layers/ids.ts"

describe("parseArgs", () => {
  it("parses --version flag", async () => {
    const result = await Effect.runPromise(parseArgs(["--version"]))
    expect(result).toEqual({ command: "version" })
  })

  it("parses -v short flag", async () => {
    const result = await Effect.runPromise(parseArgs(["-v"]))
    expect(result).toEqual({ command: "version" })
  })

  it("parses --help flag", async () => {
    const result = await Effect.runPromise(parseArgs(["--help"]))
    expect(result).toEqual({ command: "help" })
  })

  it("parses -h short flag", async () => {
    const result = await Effect.runPromise(parseArgs(["-h"]))
    expect(result).toEqual({ command: "help" })
  })

  it("parses init command", async () => {
    const result = await Effect.runPromise(parseArgs(["init"]))
    expect(result).toEqual({ command: "init" })
  })

  it("init --help routes to help, not init", async () => {
    const result = await Effect.runPromise(parseArgs(["init", "--help"]))
    expect(result).toMatchObject({ command: "help" })
  })

  it("init -h routes to help, not init", async () => {
    const result = await Effect.runPromise(parseArgs(["init", "-h"]))
    expect(result).toMatchObject({ command: "help" })
  })

  it("returns unknown for unrecognised commands", async () => {
    const result = await Effect.runPromise(parseArgs(["no-such"]))
    expect(result).toEqual({ command: "unknown", raw: ["no-such"] })
  })

  it("returns help for empty args", async () => {
    const result = await Effect.runPromise(parseArgs([]))
    expect(result).toMatchObject({ command: "help" })
  })
})

describe("version", () => {
  it("is a semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})

/** Run a dispatch effect with fake DB + ID services. */
const runDispatch = (args: Parameters<typeof dispatch>[0]) =>
  Effect.runPromiseExit(
    Effect.provide(
      dispatch(args),
      Layer.merge(makeDbServiceTest(), makeIdServiceTest([])),
    ),
  )

describe("dispatch", () => {
  it("version command completes without error", async () => {
    const exit = await runDispatch({ command: "version" })
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("help command completes without error", async () => {
    const exit = await runDispatch({ command: "help" })
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("unknown command fails with PithosError USER_ERROR", async () => {
    const exit = await runDispatch({ command: "unknown", raw: ["no-such-cmd"] })
    expect(Exit.isFailure(exit)).toBe(true)
    const err = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : { _tag: "None" as const }
    expect(err._tag).toBe("Some")
    const pithos = err._tag === "Some" ? err.value : null
    expect(pithos?._tag).toBe("PithosError")
    expect(pithos?.code).toBe("USER_ERROR")
  })
})
