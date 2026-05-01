import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { parseArgs } from "../src/cli/args.ts"
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
