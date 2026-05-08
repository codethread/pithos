import { describe, expect, it } from "vitest"
import { PdxError } from "./errors.ts"
import { filterLogLines, parseSince } from "./supervisor-log.ts"

describe("parseSince", () => {
  const now = new Date("2026-05-08T12:00:00.000Z")

  it.each([
    ["10m", "2026-05-08T11:50:00.000Z"],
    ["1h", "2026-05-08T11:00:00.000Z"],
    ["2d", "2026-05-06T12:00:00.000Z"],
    ["1w", "2026-05-01T12:00:00.000Z"],
    ["2026-05-07T00:00:00.000Z", "2026-05-07T00:00:00.000Z"],
  ])("accepts %s", (input, expected) => {
    expect(parseSince(input, now).toISOString()).toBe(expected)
  })

  it("accepts today and yesterday", () => {
    const today = parseSince("today", now)
    expect(today.getFullYear()).toBe(now.getFullYear())
    expect(today.getMonth()).toBe(now.getMonth())
    expect(today.getDate()).toBe(now.getDate())
    expect(today.getHours()).toBe(0)
    expect(today.getMinutes()).toBe(0)

    const yesterday = parseSince("yesterday", now)
    const yesterdayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    expect(yesterday.getTime()).toBe(yesterdayLocal.getTime())
  })

  it("rejects malformed values loudly", () => {
    expect(() => parseSince("bogus", now)).toThrowError(PdxError)
  })
})

describe("filterLogLines", () => {
  const lines = [
    JSON.stringify({ ts: "2026-05-08T10:00:00.000Z", level: "info", span: "a", msg: "one" }),
    JSON.stringify({ ts: "2026-05-08T11:00:00.000Z", level: "info", span: "a", msg: "two" }),
    JSON.stringify({ ts: "2026-05-08T12:00:00.000Z", level: "info", span: "a", msg: "three" }),
  ]

  it("applies since before limit", () => {
    const result = filterLogLines(lines, {
      limit: 1,
      all: false,
      since: new Date("2026-05-08T10:30:00.000Z"),
    })

    expect(result).toEqual([lines[2]])
  })
})
