import { describe, it, expect } from "vitest"
import { Effect, Exit, Cause } from "effect"
import { parseArgs } from "../src/cli/args.ts"
import { dispatch } from "../src/cli/dispatch.ts"
import { VERSION } from "../src/version.ts"

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

  it("returns unknown for unrecognised commands", async () => {
    const result = await Effect.runPromise(parseArgs(["init"]))
    expect(result).toEqual({ command: "unknown", raw: ["init"] })
  })

  it("returns unknown for empty args", async () => {
    const result = await Effect.runPromise(parseArgs([]))
    expect(result).toEqual({ command: "unknown", raw: [] })
  })
})

describe("version", () => {
  it("is a semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe("dispatch", () => {
  it("version command completes without error", async () => {
    const exit = await Effect.runPromiseExit(dispatch({ command: "version" }))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("help command completes without error", async () => {
    const exit = await Effect.runPromiseExit(dispatch({ command: "help" }))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("unknown command fails with PithosError USER_ERROR", async () => {
    const exit = await Effect.runPromiseExit(
      dispatch({ command: "unknown", raw: ["no-such-cmd"] }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const err = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : { _tag: "None" as const }
    expect(err._tag).toBe("Some")
    const pithos = err._tag === "Some" ? err.value : null
    expect(pithos?._tag).toBe("PithosError")
    expect(pithos?.code).toBe("USER_ERROR")
  })
})
