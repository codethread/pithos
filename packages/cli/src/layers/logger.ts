import { HashMap, Layer, List, Logger, LogLevel } from "effect"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogEntry {
  readonly level: string
  readonly message: string
  readonly date: Date
  readonly spans: readonly string[]
  readonly annotations: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map PITHOS_LOG_LEVEL env string to an Effect LogLevel.
 * Defaults to Warning so debug/info logs are suppressed unless explicitly
 * turned up.
 */
const getEnvLogLevel = (): LogLevel.LogLevel => {
  const raw = process.env.PITHOS_LOG_LEVEL?.toLowerCase()
  switch (raw) {
    case "trace":
      return LogLevel.Trace
    case "debug":
      return LogLevel.Debug
    case "info":
      return LogLevel.Info
    case "warning":
    case "warn":
      return LogLevel.Warning
    case "error":
      return LogLevel.Error
    case "fatal":
      return LogLevel.Fatal
    case "none":
      return LogLevel.None
    default:
      return LogLevel.Warning
  }
}

/**
 * A structured JSON logger that writes to process.stderr, keeping diagnostics
 * cleanly separate from user-visible CLI output on stdout/stderr via
 * OutputService.
 *
 * Format: one JSON object per line, fields:
 *   ts      – ISO-8601 timestamp
 *   level   – log level label (DEBUG, INFO, WARN, ERROR, FATAL)
 *   msg     – log message
 *   spans   – active log-span labels (innermost first), omitted when empty
 *   ctx     – annotation key/value pairs, omitted when empty
 */
const pithosStderrLogger = Logger.make<unknown, void>(
  ({ logLevel, message, date, spans, annotations }) => {
    const entry: Record<string, unknown> = {
      ts: date.toISOString(),
      level: logLevel.label,
      msg: String(message),
    }

    if (List.isCons(spans)) {
      const labels: string[] = []
      for (const s of spans) labels.push(s.label)
      entry.spans = labels
    }

    if (HashMap.size(annotations) > 0) {
      const ctx: Record<string, string> = {}
      for (const [k, v] of annotations) ctx[k] = String(v)
      entry.ctx = ctx
    }

    process.stderr.write(JSON.stringify(entry) + "\n")
  },
)

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

/**
 * `LoggerLive` — routes Effect log calls to stderr as structured JSON.
 *
 * The minimum log level is controlled by the `PITHOS_LOG_LEVEL` environment
 * variable (trace | debug | info | warning | error | fatal | none).
 * Defaults to `warning` so debug/info breadcrumbs are suppressed unless the
 * caller explicitly opts in.
 *
 * Combine with `OutputService` in the provider stack so diagnostics (logger)
 * stay on a separate channel from user-visible command output (OutputService).
 */
export const LoggerLive: Layer.Layer<never> = Layer.merge(
  Logger.replace(Logger.defaultLogger, pithosStderrLogger),
  Logger.minimumLogLevel(getEnvLogLevel()),
)

// ---------------------------------------------------------------------------
// Silent layer — for tests that don't care about diagnostics
// ---------------------------------------------------------------------------

/**
 * `LoggerSilent` — discards all Effect log output. Use in tests that are not
 * asserting on diagnostic messages so Vitest output stays quiet.
 *
 * Replaces the default logger with Logger.none (a no-op). Does NOT set a
 * global minimum-log-level filter so that `makeLogCapture` layers can still
 * capture diagnostics when provided alongside this layer — both layers add
 * their loggers additively, and Logger.none simply produces no output while
 * the capture logger records entries.
 */
export const LoggerSilent: Layer.Layer<never> = Logger.replace(
  Logger.defaultLogger,
  Logger.none,
)

// ---------------------------------------------------------------------------
// Capture layer — for tests that assert on diagnostic messages
// ---------------------------------------------------------------------------

export interface LogCapture {
  /** Provide this layer to the effect under test. */
  readonly layer: Layer.Layer<never>
  /** Returns all log entries emitted so far. */
  readonly entries: () => readonly LogEntry[]
}

/**
 * `makeLogCapture` — returns a capture layer and an inspector for the log
 * entries it collects.
 *
 * @param minLevel Minimum log level to capture (default: Trace — captures all levels).
 *
 * ```ts
 * const cap = makeLogCapture()
 * await Effect.runPromise(myEffect.pipe(Effect.provide(cap.layer)))
 * expect(cap.entries()).toContainEqual(expect.objectContaining({ level: "DEBUG" }))
 * ```
 */
export const makeLogCapture = (
  minLevel: LogLevel.LogLevel = LogLevel.Trace,
): LogCapture => {
  const entries: LogEntry[] = []

  const captureLogger = Logger.make<unknown, void>(
    ({ logLevel, message, date, spans, annotations }) => {
      const spanLabels: string[] = []
      if (List.isCons(spans)) {
        for (const s of spans) spanLabels.push(s.label)
      }

      const anns: Record<string, string> = {}
      if (HashMap.size(annotations) > 0) {
        for (const [k, v] of annotations) anns[k] = String(v)
      }

      entries.push({
        level: logLevel.label,
        message: String(message),
        date,
        spans: spanLabels,
        annotations: anns,
      })
    },
  )

  return {
    layer: Layer.merge(
      Logger.replace(Logger.defaultLogger, captureLogger),
      Logger.minimumLogLevel(minLevel),
    ),
    entries: () => entries,
  }
}
