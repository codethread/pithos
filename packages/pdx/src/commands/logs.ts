import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { PdxError } from "../errors.ts"
import { logPath, resolveHome } from "../home.ts"
import { OutputService } from "../services/output.ts"
import { filterLogLines, parseSince } from "../supervisor-log.ts"

export const logsShowCommand = (options: {
  readonly home?: string
  readonly limit?: number
  readonly all: boolean
  readonly since?: string
}): Effect.Effect<void, PdxError, OutputService> =>
  Effect.gen(function* () {
    const output = yield* OutputService
    const home = resolveHome(options.home)

    if (options.limit !== undefined && options.limit <= 0) {
      return yield* Effect.fail(
        new PdxError({ code: "VALIDATION_ERROR", message: "--limit must be greater than 0" }),
      )
    }
    const path = logPath(home)
    const content = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: () => new PdxError({ code: "NOT_FOUND", message: `Supervisor log not found: ${path}` }),
    })
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const filtered = filterLogLines(lines, {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      all: options.all,
      ...(options.since === undefined
        ? {}
        : { since: parseSince(options.since, new Date()) }),
    })

    for (const line of filtered) {
      yield* output.print(line)
    }
  })
