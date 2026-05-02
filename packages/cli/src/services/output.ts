import { Context, type Effect } from "effect"

/**
 * `OutputService` — centralises all user-visible CLI output.
 *
 * Commands emit lines through `print` (stdout) and `printError` (stderr)
 * rather than calling `console.log`/`console.error` directly. The live layer
 * writes to the real process streams; test layers buffer lines so tests can
 * assert on output without noisy global interception.
 */
export class OutputService extends Context.Tag("@pithos/OutputService")<
  OutputService,
  {
    /** Write a line to stdout (no trailing newline added by caller). */
    readonly print: (line: string) => Effect.Effect<void>
    /** Write a line to stderr (no trailing newline added by caller). */
    readonly printError: (line: string) => Effect.Effect<void>
  }
>() {}
