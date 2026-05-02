import { Effect, Metric } from "effect"

// ---------------------------------------------------------------------------
// Task lifecycle counters
// ---------------------------------------------------------------------------

/**
 * Incremented on each successful `pithos claim` that returns a task.
 * OTLP name: pithos.tasks.claimed
 */
export const tasksClaimedCounter = Metric.counter("pithos.tasks.claimed", {
  description: "Number of tasks successfully claimed",
  incremental: true,
})

/**
 * Incremented on each heartbeat write that is NOT throttled/skipped.
 * OTLP name: pithos.heartbeats.written
 */
export const heartbeatsWrittenCounter = Metric.counter("pithos.heartbeats.written", {
  description: "Number of heartbeat writes committed (non-throttled)",
  incremental: true,
})

/**
 * Incremented each time a heartbeat is skipped because it falls within the
 * throttle window.
 * OTLP name: pithos.heartbeats.throttled
 */
export const heartbeatsThrottledCounter = Metric.counter("pithos.heartbeats.throttled", {
  description: "Number of heartbeats skipped due to throttle window",
  incremental: true,
})

// ---------------------------------------------------------------------------
// Stale-token rejection counters (per command)
//
// Separate counters per command rather than a single tagged counter; this
// avoids the Effect type incompatibility where Metric.tagged() produces
// In=never on the wrapped metric (making Metric.increment unusable). Per-
// command names are also more explicit and easier to alert on in OTLP.
// ---------------------------------------------------------------------------

/**
 * Stale fencing-token rejections on `pithos heartbeat`.
 * OTLP name: pithos.stale_tokens.heartbeat
 */
export const staleTokensHeartbeatCounter = Metric.counter("pithos.stale_tokens.heartbeat", {
  description: "Stale fencing-token rejections on pithos heartbeat",
  incremental: true,
})

/**
 * Stale fencing-token rejections on `pithos complete`.
 * OTLP name: pithos.stale_tokens.complete
 */
export const staleTokensCompleteCounter = Metric.counter("pithos.stale_tokens.complete", {
  description: "Stale fencing-token rejections on pithos complete",
  incremental: true,
})

/**
 * Stale fencing-token rejections on `pithos fail`.
 * OTLP name: pithos.stale_tokens.fail
 */
export const staleTokensFailCounter = Metric.counter("pithos.stale_tokens.fail", {
  description: "Stale fencing-token rejections on pithos fail",
  incremental: true,
})

// ---------------------------------------------------------------------------
// Sweep counters (defined now; wired into sweep when task 13 is built)
// ---------------------------------------------------------------------------

/**
 * Incremented by `pithos sweep` for each task requeued (attempts < max_attempts).
 * OTLP name: pithos.sweep.requeued
 */
export const sweepRequeuedCounter = Metric.counter("pithos.sweep.requeued", {
  description: "Number of expired tasks requeued by sweep",
  incremental: true,
})

/**
 * Incremented by `pithos sweep` for each task dead-lettered (attempts >= max_attempts).
 * OTLP name: pithos.sweep.dead_lettered
 */
export const sweepDeadLetteredCounter = Metric.counter("pithos.sweep.dead_lettered", {
  description: "Number of expired tasks dead-lettered by sweep",
  incremental: true,
})

// ---------------------------------------------------------------------------
// Duration histogram
// ---------------------------------------------------------------------------

/**
 * Histogram of command execution durations in milliseconds.
 * Shared across all commands; tagged per call site via:
 *   commandDurationTimer.pipe(Metric.tagged("command", "claim"))
 *
 * Note: Metric.tagged() is compatible with Metric.trackDuration because
 * Duration satisfies the `In extends Duration.Duration` constraint even after
 * the tag is applied.  Do NOT attempt to call Metric.increment() on a tagged
 * timer — use trackDuration exclusively.
 *
 * Compatible with OTLP histogram export when `@effect/opentelemetry` is
 * wired into the provider stack.
 *
 * OTLP name: pithos.command.duration
 */
export const commandDurationTimer = Metric.timer("pithos.command.duration", "millis")

// ---------------------------------------------------------------------------
// Observability wrapper
// ---------------------------------------------------------------------------

/**
 * Decorates an effect with:
 *  - A tracing span (`Effect.withSpan`) named `pithos.<commandName>`.
 *    Spans are no-ops by default; wire in `@effect/opentelemetry` to export
 *    them to an OTLP collector.
 *  - A command-duration histogram update tagged with `command=<commandName>`.
 *
 * Compose this around the outermost effect after `Effect.withLogSpan` so the
 * duration covers the full command execution including log-span setup:
 *
 *   Effect.gen(function* () { ... }).pipe(
 *     Effect.withLogSpan("pithos.claim"),
 *     withCommandObservability("claim"),
 *   )
 *
 * @param commandName  Short label, e.g. "claim", "heartbeat", "complete".
 */
export const withCommandObservability =
  (commandName: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.withSpan(`pithos.${commandName}`),
      Metric.trackDuration(commandDurationTimer.pipe(Metric.tagged("command", commandName))),
    )
