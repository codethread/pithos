import { Effect } from "effect"
import type { ScopeKind } from "../domain/scope.ts"
import type { PithosError } from "../errors/errors.ts"

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
      status: "ended" | "failed" | "cancelled"
      summary: string | undefined
    }
  | { command: "inspect:scope"; id: string }
  | { command: "inspect:run"; id: string }
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

const hasHelp = (argv: readonly string[]): boolean =>
  argv.includes("--help") || argv.includes("-h")

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export const parseArgs = (argv: readonly string[]): Effect.Effect<ParsedArgs, PithosError> =>
  Effect.sync(() => {
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
        const kind: ScopeKind =
          rawKind === "global" || rawKind === "repo" || rawKind === "worktree"
            ? rawKind
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
        const rawStatus = flagValue(argv, "--status")
        const status: "ended" | "failed" | "cancelled" =
          rawStatus === "failed" || rawStatus === "cancelled" ? rawStatus : "ended"
        const summary = flagValue(argv, "--summary")
        return { command: "run:end", run, status, summary } as const
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
      return { command: "unknown", raw: argv } as const
    }

    return { command: "unknown", raw: argv } as const
  })
