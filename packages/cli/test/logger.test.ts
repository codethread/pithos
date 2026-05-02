import { describe, it, expect } from "vitest"
import { Exit, Effect, Layer, Logger, LogLevel } from "effect"
import { makeLogCapture, LoggerSilent } from "../src/layers/logger.ts"
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts"
import { OutputService } from "../src/services/output.ts"
import { makeDbServiceTest } from "../src/layers/db.ts"
import { makeFsServiceTest } from "../src/layers/fs.ts"
import { completeCommand } from "../src/commands/complete.ts"
import { claimCommand } from "../src/commands/claim.ts"
import { failCommand } from "../src/commands/fail.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// makeLogCapture — core behaviour
// ---------------------------------------------------------------------------

describe("makeLogCapture", () => {
  it("captures a debug log entry when min level is Trace", async () => {
    const cap = makeLogCapture(LogLevel.Trace)
    await Effect.runPromise(
      Effect.logDebug("hello debug").pipe(Effect.provide(cap.layer)),
    )
    expect(cap.entries()).toHaveLength(1)
    const entry = cap.entries()[0]!
    expect(entry.level).toBe("DEBUG")
    expect(entry.message).toBe("hello debug")
    expect(entry.date).toBeInstanceOf(Date)
  })

  it("captures multiple levels in order", async () => {
    const cap = makeLogCapture(LogLevel.Trace)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logDebug("debug msg")
        yield* Effect.logInfo("info msg")
        yield* Effect.logWarning("warning msg")
        yield* Effect.logError("error msg")
      }).pipe(Effect.provide(cap.layer)),
    )
    expect(cap.entries().map((e) => e.level)).toEqual(["DEBUG", "INFO", "WARN", "ERROR"])
  })

  it("filters out entries below the minimum level", async () => {
    const cap = makeLogCapture(LogLevel.Warning)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logDebug("debug — filtered")
        yield* Effect.logInfo("info — filtered")
        yield* Effect.logWarning("warning — captured")
        yield* Effect.logError("error — captured")
      }).pipe(Effect.provide(cap.layer)),
    )
    expect(cap.entries().map((e) => e.level)).toEqual(["WARN", "ERROR"])
  })

  it("captures log-span labels in the spans array", async () => {
    const cap = makeLogCapture(LogLevel.Trace)
    await Effect.runPromise(
      Effect.withLogSpan("outer")(
        Effect.withLogSpan("inner")(Effect.logDebug("inside spans")),
      ).pipe(Effect.provide(cap.layer)),
    )
    const entry = cap.entries()[0]!
    expect(entry.spans).toContain("inner")
    expect(entry.spans).toContain("outer")
  })

  it("captures annotations from annotateLogs", async () => {
    const cap = makeLogCapture(LogLevel.Trace)
    await Effect.runPromise(
      Effect.logDebug("annotated").pipe(
        Effect.annotateLogs({ taskId: "task_abc", runId: "run_xyz" }),
        Effect.provide(cap.layer),
      ),
    )
    const entry = cap.entries()[0]!
    expect(entry.annotations).toMatchObject({ taskId: "task_abc", runId: "run_xyz" })
  })

  it("accumulates entries across multiple effects", async () => {
    const cap = makeLogCapture(LogLevel.Trace)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logDebug("first")
        yield* Effect.logDebug("second")
        yield* Effect.logDebug("third")
      }).pipe(Effect.provide(cap.layer)),
    )
    expect(cap.entries()).toHaveLength(3)
    expect(cap.entries().map((e) => e.message)).toEqual(["first", "second", "third"])
  })
})

// ---------------------------------------------------------------------------
// LoggerSilent
// ---------------------------------------------------------------------------

describe("LoggerSilent", () => {
  it("suppresses a simple (non-nested) logger layer when placed after it in merge", async () => {
    // LoggerSilent wins when merged as the RIGHT side over a simple Logger.replace layer.
    // This mirrors what happens in production: the default Effect logger (console.log) is
    // suppressed by LoggerSilent so diagnostic breadcrumbs don't pollute Vitest output.
    let fired = 0
    const countingLogger = Logger.make<unknown, void>(() => { fired++ })
    const simpleCountingLayer = Logger.replace(Logger.defaultLogger, countingLogger)

    await Effect.runPromise(
      Effect.logDebug("diagnostic").pipe(
        Effect.provide(Layer.merge(simpleCountingLayer, LoggerSilent)),
      ),
    )

    // LoggerSilent (RIGHT) wins the FiberRef race → minimumLogLevel=None →
    // no log passes the level gate → countingLogger never fires
    expect(fired).toBe(0)
  })

  it("silences logs while OutputService still emits normally", async () => {
    const output = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logWarning("this is diagnostic — silent")
        const out = yield* OutputService
        yield* out.print("this is user output")
      }).pipe(Effect.provide(Layer.merge(LoggerSilent, output.layer))),
    )
    expect(output.lines()).toEqual(["this is user output"])
  })
})

// ---------------------------------------------------------------------------
// Diagnostics are isolated from OutputService
// ---------------------------------------------------------------------------

describe("diagnostic logs do not bleed into OutputService", () => {
  it("logDebug lines do not appear in print captures", async () => {
    const cap = makeLogCapture(LogLevel.Trace)
    const output = makeOutputServiceTest()

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logDebug("diagnostic breadcrumb")
        const out = yield* OutputService
        yield* out.print("user-visible line")
      }).pipe(Effect.provide(Layer.merge(cap.layer, output.layer))),
    )

    expect(cap.entries().map((e) => e.message)).toContain("diagnostic breadcrumb")
    expect(output.lines()).toEqual(["user-visible line"])
    // The diagnostic must not appear in output
    expect(output.lines()).not.toContain("diagnostic breadcrumb")
  })
})

// ---------------------------------------------------------------------------
// Command diagnostics — complete command
// ---------------------------------------------------------------------------

describe("complete command emits diagnostic breadcrumbs", () => {
  it("emits a WARNING when a stale fencing token is rejected", async () => {
    const cap = makeLogCapture(LogLevel.Debug)
    // Fake DB returns no rows from the transaction UPDATE → stale token path
    const db = makeDbServiceTest()
    const fs = makeFsServiceTest()

    const exit = await Effect.runPromiseExit(
      completeCommand({ taskId: "task_1", run: "run_1", token: 99 }).pipe(
        Effect.provide(Layer.mergeAll(db, makeOutputServiceSilent(), fs, cap.layer)),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const warnings = cap.entries().filter((e) => e.level === "WARN")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]!.message).toMatch(/stale fencing token/i)
    expect(warnings[0]!.spans).toContain("pithos.complete")
  })
})

// ---------------------------------------------------------------------------
// Command diagnostics — fail command
// ---------------------------------------------------------------------------

describe("fail command emits diagnostic breadcrumbs", () => {
  it("emits a WARNING when a stale fencing token is rejected", async () => {
    const cap = makeLogCapture(LogLevel.Debug)
    const db = makeDbServiceTest()

    const exit = await Effect.runPromiseExit(
      failCommand({ taskId: "task_1", run: "run_1", token: 99 }).pipe(
        Effect.provide(Layer.mergeAll(db, makeOutputServiceSilent(), cap.layer)),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const warnings = cap.entries().filter((e) => e.level === "WARN")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]!.message).toMatch(/stale fencing token/i)
    expect(warnings[0]!.spans).toContain("pithos.fail")
  })
})

// ---------------------------------------------------------------------------
// Command diagnostics — claim command (no claimable work)
// ---------------------------------------------------------------------------

describe("claim command emits diagnostic breadcrumbs", () => {
  it("emits a DEBUG log when no claimable work is found", async () => {
    const cap = makeLogCapture(LogLevel.Debug)
    // Seed run validation to pass, but no task rows from the UPDATE RETURNING
    const db = makeDbServiceTest(
      new Map([
        ["SELECT id FROM runs WHERE id = ?", [{ id: "run_1" }]],
      ]),
    )

    const exit = await Effect.runPromiseExit(
      claimCommand({
        run: "run_1",
        scope: "global",
        capability: "watch",
      }).pipe(
        Effect.provide(Layer.merge(db, makeOutputServiceSilent())),
        Effect.provide(cap.layer),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const debugs = cap.entries().filter((e) => e.level === "DEBUG")
    expect(debugs.some((e) => e.message === "no claimable work")).toBe(true)
    // Span label from withLogSpan
    const noWorkEntry = debugs.find((e) => e.message === "no claimable work")!
    expect(noWorkEntry.spans).toContain("pithos.claim")
  })
})
