import { Effect, Schema } from "effect"
import type { ScopeKind } from "../domain/scope.ts"
import { ScopeKindSchema } from "../domain/scope.ts"
import { PithosError } from "../errors/errors.ts"

export type ParsedArgs =
  | { command: "version" }
  | { command: "help"; topic?: string }
  | { command: "init" }
  | { command: "scope:upsert"; kind: ScopeKind; path: string | undefined }
  | {
      command: "run:register"
      agentKind: string | undefined
      scopeId: string | undefined
      cwd: string | undefined
      sessionId: string | undefined
      parentRun: string | undefined
      run: string | undefined
    }
  | {
      command: "run:end"
      run: string | undefined
      status: string | undefined
      summary: string | undefined
    }
  | {
      command: "enqueue"
      scope: string | undefined
      capability: string | undefined
      title: string | undefined
      body: string | undefined
      bodyFile: string | undefined
      run: string | undefined
      parentId: string | undefined
    }
  | {
      command: "claim"
      run: string | undefined
      scope: string | undefined
      capability: string | undefined
      leaseMinutes: number | undefined
    }
  | {
      command: "heartbeat"
      run: string | undefined
      task: string | undefined
      token: number | undefined
      hook: string | undefined
      throttleSeconds: number | undefined
    }
  | {
      command: "complete"
      taskId: string | undefined
      run: string | undefined
      token: number | undefined
      resultFile: string | undefined
    }
  | {
      command: "fail"
      taskId: string | undefined
      run: string | undefined
      token: number | undefined
      reason: string | undefined
    }
  | {
      command: "artifact:add"
      task: string | undefined
      run: string | undefined
      kind: string | undefined
      title: string | undefined
      bodyFile: string | undefined
    }
  | { command: "inspect:scope"; id: string }
  | { command: "inspect:run"; id: string }
  | { command: "inspect:task"; id: string }
  | { command: "tail"; limit: number | undefined }
  | { command: "sweep"; leaseGraceSeconds: number | undefined; runStaleMinutes: number | undefined }
  | { command: "briefing"; agent: string | undefined }
  | { command: "unknown"; raw: readonly string[] }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the value following a named flag, or undefined if not present or if the next token is itself a flag. */
const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const idx = argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= argv.length) return undefined
  const next = argv[idx + 1]
  // Reject another flag token as a value (e.g. --path --kind is invalid)
  if (next === undefined || next.startsWith("-")) return undefined
  return next
}

/**
 * Like flagValue but does NOT reject tokens starting with "-".
 * Used for numeric flags where negative values (e.g. --token -1) must reach
 * the Schema decoder rather than being silently dropped.
 */
const rawFlagValue = (argv: readonly string[], flag: string): string | undefined => {
  const idx = argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= argv.length) return undefined
  return argv[idx + 1]
}

const hasHelp = (argv: readonly string[]): boolean =>
  argv.includes("--help") || argv.includes("-h")

// ---------------------------------------------------------------------------
// Numeric flag helpers
// ---------------------------------------------------------------------------

/** Integer schema: parse a string token as a safe integer (rejects NaN, float, Infinity). */
const IntFromString = Schema.NumberFromString.pipe(Schema.int())

/**
 * Read a named flag's value and parse it as an integer via Schema.
 * Returns undefined when the flag is absent; fails with VALIDATION_ERROR for
 * non-integer values.
 */
const intFlagValue = (
  argv: readonly string[],
  flag: string,
): Effect.Effect<number | undefined, PithosError> =>
  Effect.gen(function* () {
    const raw = rawFlagValue(argv, flag)
    if (raw === undefined) return undefined
    return yield* Schema.decodeUnknown(IntFromString)(raw).pipe(
      Effect.mapError(
        () =>
          new PithosError({
            code: "VALIDATION_ERROR",
            message: `${flag} must be an integer, got: '${raw}'`,
          }),
      ),
    )
  })

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export const parseArgs = (argv: readonly string[]): Effect.Effect<ParsedArgs, PithosError> =>
  Effect.gen(function* () {
    const [first, second, ...rest] = argv

    if (!first || first === "--help" || first === "-h" || first === "help") {
      return { command: "help" } as const
    }

    if (first === "--version" || first === "-v") {
      return { command: "version" } as const
    }

    if (first === "init") {
      if (hasHelp(argv.slice(1))) return { command: "help", topic: "init" } as const
      return { command: "init" } as const
    }

    if (first === "scope") {
      if (!second || second === "--help" || second === "-h") {
        return { command: "help", topic: "scope" } as const
      }
      if (second === "upsert") {
        const remaining = [second, ...rest]
        if (hasHelp(remaining)) return { command: "help", topic: "scope:upsert" } as const
        const rawKind = flagValue(argv, "--kind")
        const kind: ScopeKind = rawKind !== undefined
          ? yield* Schema.decodeUnknown(ScopeKindSchema)(rawKind).pipe(
              Effect.mapError(
                () =>
                  new PithosError({
                    code: "VALIDATION_ERROR",
                    message: `Invalid --kind value: '${rawKind}'. Valid values: global, repo, worktree`,
                  }),
              ),
            )
          : "repo"
        const path = flagValue(argv, "--path")
        return { command: "scope:upsert", kind, path } as const
      }
      return { command: "unknown", raw: argv } as const
    }

    if (first === "run") {
      if (!second || second === "--help" || second === "-h") {
        return { command: "help", topic: "run" } as const
      }
      if (second === "register") {
        const remaining = [second, ...rest]
        if (hasHelp(remaining)) return { command: "help", topic: "run:register" } as const
        const agentKind = flagValue(argv, "--agent-kind")
        const scopeId = flagValue(argv, "--scope")
        const cwd = flagValue(argv, "--cwd")
        const sessionId = flagValue(argv, "--session-id")
        const parentRun = flagValue(argv, "--parent-run")
        const run = flagValue(argv, "--run")
        return { command: "run:register", agentKind, scopeId, cwd, sessionId, parentRun, run } as const
      }
      if (second === "end") {
        const remaining = [second, ...rest]
        if (hasHelp(remaining)) return { command: "help", topic: "run:end" } as const
        const run = flagValue(argv, "--run")
        const status = flagValue(argv, "--status")
        const summary = flagValue(argv, "--summary")
        return { command: "run:end", run, status, summary } as const
      }
      return { command: "unknown", raw: argv } as const
    }

    if (first === "enqueue") {
      if (hasHelp(argv.slice(1))) return { command: "help", topic: "enqueue" } as const
      const scope = flagValue(argv, "--scope")
      const capability = flagValue(argv, "--capability")
      const title = flagValue(argv, "--title")
      const body = flagValue(argv, "--body")
      const bodyFile = flagValue(argv, "--body-file")
      const run = flagValue(argv, "--run")
      const parentId = flagValue(argv, "--parent-id")
      return { command: "enqueue", scope, capability, title, body, bodyFile, run, parentId } as const
    }

    if (first === "claim") {
      if (hasHelp(argv.slice(1))) return { command: "help", topic: "claim" } as const
      const run = flagValue(argv, "--run")
      const scope = flagValue(argv, "--scope")
      const capability = flagValue(argv, "--capability")
      const leaseMinutes = yield* intFlagValue(argv, "--lease-minutes")
      return { command: "claim", run, scope, capability, leaseMinutes } as const
    }

    if (first === "heartbeat") {
      if (hasHelp(argv.slice(1))) return { command: "help", topic: "heartbeat" } as const
      const run = flagValue(argv, "--run")
      const task = flagValue(argv, "--task")
      const token = yield* intFlagValue(argv, "--token")
      const hook = flagValue(argv, "--hook")
      const throttleSeconds = yield* intFlagValue(argv, "--throttle-seconds")
      return { command: "heartbeat", run, task, token, hook, throttleSeconds } as const
    }

    if (first === "complete") {
      if (hasHelp(argv.slice(1))) return { command: "help", topic: "complete" } as const
      const taskId = second !== undefined && !second.startsWith("-") ? second : undefined
      const run = flagValue(argv, "--run")
      const token = yield* intFlagValue(argv, "--token")
      const resultFile = flagValue(argv, "--result-file")
      return { command: "complete", taskId, run, token, resultFile } as const
    }

    if (first === "fail") {
      if (hasHelp(argv.slice(1))) return { command: "help", topic: "fail" } as const
      const taskId = second !== undefined && !second.startsWith("-") ? second : undefined
      const run = flagValue(argv, "--run")
      const token = yield* intFlagValue(argv, "--token")
      const reason = flagValue(argv, "--reason")
      return { command: "fail", taskId, run, token, reason } as const
    }

    if (first === "artifact") {
      if (!second || second === "--help" || second === "-h") {
        return { command: "help", topic: "artifact" } as const
      }
      if (second === "add") {
        const remaining = [second, ...rest]
        if (hasHelp(remaining)) return { command: "help", topic: "artifact:add" } as const
        const task = flagValue(argv, "--task")
        const run = flagValue(argv, "--run")
        const kind = flagValue(argv, "--kind")
        const title = flagValue(argv, "--title")
        const bodyFile = flagValue(argv, "--body-file")
        return { command: "artifact:add", task, run, kind, title, bodyFile } as const
      }
      return { command: "unknown", raw: argv } as const
    }

    if (first === "inspect") {
      if (!second || second === "--help" || second === "-h") {
        return { command: "help", topic: "inspect" } as const
      }
      if (second === "scope") {
        const remaining = [second, ...rest]
        if (hasHelp(remaining)) return { command: "help", topic: "inspect:scope" } as const
        const id = rest[0]
        if (!id) return { command: "unknown", raw: argv } as const
        return { command: "inspect:scope", id } as const
      }
      if (second === "run") {
        const remaining = [second, ...rest]
        if (hasHelp(remaining)) return { command: "help", topic: "inspect:run" } as const
        const id = rest[0]
        if (!id) return { command: "unknown", raw: argv } as const
        return { command: "inspect:run", id } as const
      }
      if (second === "task") {
        const remaining = [second, ...rest]
        if (hasHelp(remaining)) return { command: "help", topic: "inspect:task" } as const
        const id = rest[0]
        if (!id) return { command: "unknown", raw: argv } as const
        return { command: "inspect:task", id } as const
      }
      return { command: "unknown", raw: argv } as const
    }

    if (first === "tail") {
      if (hasHelp(argv.slice(1))) return { command: "help", topic: "tail" } as const
      const limit = yield* intFlagValue(argv, "--limit")
      return { command: "tail", limit } as const
    }

    if (first === "sweep") {
      if (hasHelp(argv.slice(1))) return { command: "help", topic: "sweep" } as const
      const leaseGraceSeconds = yield* intFlagValue(argv, "--lease-grace-seconds")
      const runStaleMinutes = yield* intFlagValue(argv, "--run-stale-minutes")
      return { command: "sweep", leaseGraceSeconds, runStaleMinutes } as const
    }

    if (first === "briefing") {
      if (hasHelp(argv.slice(1))) return { command: "help", topic: "briefing" } as const
      const agent = flagValue(argv, "--agent")
      return { command: "briefing", agent } as const
    }

    return { command: "unknown", raw: argv } as const
  })
