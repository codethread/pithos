import { Effect } from "effect"
import type { ParsedArgs } from "./args.ts"
import { PithosError } from "../errors/errors.ts"
import type { DbService } from "../services/db.ts"
import { VERSION } from "../version.ts"
import { initCommand } from "../commands/init.ts"
import { scopeUpsertCommand, SCOPE_UPSERT_HELP } from "../commands/scope.ts"
import { inspectScopeCommand, INSPECT_HELP } from "../commands/inspect.ts"

// ---------------------------------------------------------------------------
// Help texts
// ---------------------------------------------------------------------------

const HELP_TEXT = `pithos - local control plane for coordinating Claude Code agents

Usage: pithos <command> [options]

Commands:
  init                  Create DB, run migrations, default global scope
  scope upsert          Register global/repo/worktree scope
  run register          Register a Claude Code/worker/agent run
  run end               Mark a run ended/failed/cancelled
  heartbeat             Update run heartbeat; optionally advance task to running
  enqueue               Create a queued task and event
  claim                 Atomically claim one queued task for a run
  complete              Complete task if run owns current fencing token
  fail                  Fail task if run owns current fencing token
  artifact add          Attach a completion report/design brief/status artifact
  inspect               Inspect task/run/scope/artifact
  briefing              Render concise briefing for Pandora or a scope
  tail                  Show recent events
  sweep                 Expire leases, mark stale runs, requeue eligible tasks

Global options:
  --help, -h            Show this help
  --version, -v         Show version

Environment:
  PITHOS_DB             SQLite DB path (default: ~/.pandora/pithos.sqlite)
  PITHOS_RUN_ID         Current run ID for hooks/agents
  PITHOS_TASK_ID        Current claimed task ID
  PITHOS_FENCING_TOKEN  Current task claim token
  PITHOS_SCOPE_ID       Scope hint for current session
  PITHOS_OUTPUT         Output format: json or text (default: json)

Exit codes:
  0  Success
  1  General/user error
  2  Validation error
  3  Not found
  4  Stale lease/fencing token
  5  No claimable work

Run \`pithos <command> --help\` for command-specific usage.
`

const helpFor = (topic: string | undefined): string => {
  switch (topic) {
    case "scope":
    case "scope:upsert":
      return SCOPE_UPSERT_HELP
    case "inspect":
    case "inspect:scope":
      return INSPECT_HELP
    default:
      return HELP_TEXT
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const dispatch = (args: ParsedArgs): Effect.Effect<void, PithosError, DbService> =>
  Effect.gen(function* () {
    switch (args.command) {
      case "version":
        console.log(VERSION)
        break

      case "help":
        console.log(helpFor(args.topic))
        break

      case "init":
        yield* initCommand
        break

      case "scope:upsert":
        yield* scopeUpsertCommand({ kind: args.kind, path: args.path })
        break

      case "inspect:scope":
        yield* inspectScopeCommand(args.id)
        break

      case "unknown": {
        const cmd = args.raw[0] ?? "(none)"
        console.error(`pithos: unknown command '${cmd}'\nRun \`pithos --help\` for usage.`)
        yield* Effect.fail(
          new PithosError({ code: "USER_ERROR", message: `Unknown command: ${cmd}` }),
        )
        break
      }
    }
  })
