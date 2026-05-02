import { Effect, Layer } from "effect"
import { OutputService } from "../services/output.ts"
import { LoggerSilent } from "./logger.ts"

// ---------------------------------------------------------------------------
// Live layer — writes to the real process streams
// ---------------------------------------------------------------------------

export const OutputServiceLive: Layer.Layer<OutputService> = Layer.succeed(OutputService, {
  print: (line) => Effect.sync(() => { process.stdout.write(line + "\n") }),
  printError: (line) => Effect.sync(() => { process.stderr.write(line + "\n") }),
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Buffering output capture for tests that assert on printed lines.
 * Call `capture.lines()` after running the effect to inspect stdout output.
 */
export interface OutputCapture {
  readonly layer: Layer.Layer<OutputService>
  readonly lines: () => readonly string[]
  readonly errorLines: () => readonly string[]
}

export const makeOutputServiceTest = (): OutputCapture => {
  const lines: string[] = []
  const errorLines: string[] = []
  return {
    // LoggerSilent is merged so Effect diagnostic logs don't bleed into test
    // output. Tests that need to capture logs should provide makeLogCapture()
    // *after* this layer (right-hand side wins) to override the silent logger.
    layer: Layer.merge(
      Layer.succeed(OutputService, {
        print: (line) => Effect.sync(() => { lines.push(line) }),
        printError: (line) => Effect.sync(() => { errorLines.push(line) }),
      }),
      LoggerSilent,
    ),
    lines: () => lines,
    errorLines: () => errorLines,
  }
}

/**
 * Silent output layer for test setup helpers that don't care about printed output.
 * Discards all output without buffering.
 *
 * Also silences Effect diagnostic logs (LoggerSilent) so unit/integration
 * tests that use this layer stay quiet. Tests that need to capture logs
 * should provide makeLogCapture() *after* this layer to override the silent
 * logger (right-hand side wins in Layer.merge / Layer.mergeAll).
 */
export const makeOutputServiceSilent = (): Layer.Layer<OutputService> =>
  Layer.merge(
    Layer.succeed(OutputService, {
      print: () => Effect.void,
      printError: () => Effect.void,
    }),
    LoggerSilent,
  )
