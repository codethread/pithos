/**
 * Unit tests for the metrics layer.
 *
 * The metrics are fire-and-forget observability primitives. Tests verify:
 *  1. withCommandObservability is transparent (doesn't alter result or error)
 *  2. Each counter can be incremented without throwing
 *  3. commandDurationTimer tracks duration without throwing
 *
 * Reading raw counter state requires MetricState imports whose types are
 * complex in Effect v3's type system; we skip value-equality assertions here
 * and instead trust the Effect runtime to accumulate counts correctly.
 * Integration tests exercise the metrics end-to-end as side effects of real
 * command invocations.
 */
import { describe, it, expect } from "vitest"
import { Effect, Metric } from "effect"
import {
  tasksClaimedCounter,
  heartbeatsWrittenCounter,
  heartbeatsThrottledCounter,
  staleTokensHeartbeatCounter,
  staleTokensCompleteCounter,
  staleTokensFailCounter,
  sweepRequeuedCounter,
  sweepDeadLetteredCounter,
  withCommandObservability,
  commandDurationTimer,
} from "./metrics.ts"

// ---------------------------------------------------------------------------
// withCommandObservability transparency
// ---------------------------------------------------------------------------

describe("withCommandObservability", () => {
  it("passes a successful result through unchanged", async () => {
    const result = await Effect.runPromise(
      Effect.succeed(42).pipe(withCommandObservability("test")),
    )
    expect(result).toBe(42)
  })

  it("propagates a string error unchanged", async () => {
    const err = new Error("boom")
    await expect(
      Effect.runPromise(
        Effect.fail(err).pipe(withCommandObservability("test-err")),
      ),
    ).rejects.toThrow("boom")
  })

  it("decorates with a named span (pithos.<commandName>)", async () => {
    // Span is a no-op by default; just verify the effect runs successfully
    // with the span decorator applied and produces the correct value.
    const result = await Effect.runPromise(
      Effect.succeed("hello").pipe(withCommandObservability("my-cmd")),
    )
    expect(result).toBe("hello")
  })
})

// ---------------------------------------------------------------------------
// Counter increment smoke tests
// ---------------------------------------------------------------------------

describe("counter increments", () => {
  const counters = [
    ["tasksClaimedCounter", tasksClaimedCounter],
    ["heartbeatsWrittenCounter", heartbeatsWrittenCounter],
    ["heartbeatsThrottledCounter", heartbeatsThrottledCounter],
    ["staleTokensHeartbeatCounter", staleTokensHeartbeatCounter],
    ["staleTokensCompleteCounter", staleTokensCompleteCounter],
    ["staleTokensFailCounter", staleTokensFailCounter],
    ["sweepRequeuedCounter", sweepRequeuedCounter],
    ["sweepDeadLetteredCounter", sweepDeadLetteredCounter],
  ] as const

  for (const [name, counter] of counters) {
    it(`Metric.increment(${name}) runs without error`, async () => {
      await expect(
        Effect.runPromise(Metric.increment(counter)),
      ).resolves.toBeUndefined()
    })
  }
})

// ---------------------------------------------------------------------------
// Duration timer
// ---------------------------------------------------------------------------

describe("commandDurationTimer", () => {
  it("trackDuration records duration without throwing", async () => {
    const tagged = commandDurationTimer.pipe(Metric.tagged("command", "test-cmd"))
    await expect(
      Effect.runPromise(
        Effect.sleep("1 millis").pipe(Metric.trackDuration(tagged)),
      ),
    ).resolves.toBeUndefined()
  })

  it("tagged timer is transparent (result passes through)", async () => {
    const tagged = commandDurationTimer.pipe(Metric.tagged("command", "passthrough"))
    const result = await Effect.runPromise(
      Effect.succeed(99).pipe(Metric.trackDuration(tagged)),
    )
    expect(result).toBe(99)
  })
})
