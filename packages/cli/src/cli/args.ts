import { Effect } from "effect"
import type { PithosError } from "../errors/errors.ts"

export type ParsedArgs =
  | { command: "version" }
  | { command: "help" }
  | { command: "init" }
  | { command: "unknown"; raw: readonly string[] }

export const parseArgs = (argv: readonly string[]): Effect.Effect<ParsedArgs, PithosError> =>
  Effect.sync(() => {
    const [first] = argv
    if (first === "--version" || first === "-v") {
      return { command: "version" } as const
    }
    if (first === "--help" || first === "-h" || first === "help") {
      return { command: "help" } as const
    }
    if (first === "init") {
      return { command: "init" } as const
    }
    return { command: "unknown", raw: argv } as const
  })
