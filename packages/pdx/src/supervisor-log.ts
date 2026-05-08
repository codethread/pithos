import { appendFile, readFile } from "node:fs/promises"
import { PdxError } from "./errors.ts"

export interface SupervisorLogLine {
  readonly ts: string
  readonly level: string
  readonly span: string
  readonly msg: string
  readonly [key: string]: unknown
}

export const appendSupervisorLog = async (
  path: string,
  line: SupervisorLogLine,
): Promise<void> => {
  await appendFile(path, JSON.stringify(line) + "\n", "utf8")
}

export const readSupervisorLogLines = async (path: string): Promise<readonly string[]> => {
  const content = await readFile(path, "utf8")
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

const durationPattern = /^(\d+)([mhdw])$/

export const parseSince = (input: string, now: Date): Date => {
  if (input === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  }

  if (input === "yesterday") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  }

  const durationMatch = durationPattern.exec(input)
  if (durationMatch !== null) {
    const value = Number(durationMatch[1])
    const unit = durationMatch[2]
    const unitMs =
      unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : unit === "d"
            ? 86_400_000
            : 604_800_000
    return new Date(now.getTime() - value * unitMs)
  }

  const timestamp = Date.parse(input)
  if (Number.isNaN(timestamp)) {
    throw new PdxError({
      code: "VALIDATION_ERROR",
      message: `Invalid --since value: ${input}`,
    })
  }

  return new Date(timestamp)
}

export const filterLogLines = (
  lines: readonly string[],
  options: {
    readonly limit?: number
    readonly all: boolean
    readonly since?: Date
  },
): readonly string[] => {
  const filtered = lines.filter((line) => {
    let parsed: SupervisorLogLine
    try {
      parsed = JSON.parse(line) as SupervisorLogLine
    } catch {
      throw new PdxError({
        code: "USER_ERROR",
        message: "Corrupt supervisor log line encountered",
      })
    }

    if (
      parsed.ts === undefined ||
      parsed.level === undefined ||
      parsed.span === undefined ||
      parsed.msg === undefined
    ) {
      throw new PdxError({
        code: "USER_ERROR",
        message: "Supervisor log line missing required keys",
      })
    }

    if (options.since === undefined) {
      return true
    }

    const ts = Date.parse(parsed.ts)
    if (Number.isNaN(ts)) {
      throw new PdxError({
        code: "USER_ERROR",
        message: "Supervisor log line has invalid ts",
      })
    }

    return ts >= options.since.getTime()
  })

  if (options.all) {
    return filtered
  }

  const limit = options.limit ?? 100
  return filtered.slice(Math.max(0, filtered.length - limit))
}
