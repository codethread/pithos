import { Effect } from "effect"
import type { ParsedArgs } from "./args.ts"
import { PithosError } from "../errors/errors.ts"
import type { DbService } from "../services/db.ts"
import type { IdService } from "../services/ids.ts"
import type { FsService } from "../services/fs.ts"
import { OutputService } from "../services/output.ts"
import { VERSION } from "../version.ts"
import { initCommand } from "../commands/init.ts"
import { scopeUpsertCommand, SCOPE_UPSERT_HELP } from "../commands/scope.ts"
import { inspectScopeCommand, inspectRunCommand, inspectTaskCommand, INSPECT_HELP } from "../commands/inspect.ts"
import {
  runRegisterCommand,
  runEndCommand,
  RUN_REGISTER_HELP,
  RUN_END_HELP,
} from "../commands/run.ts"
import { enqueueCommand, ENQUEUE_HELP } from "../commands/enqueue.ts"
import { claimCommand, CLAIM_HELP } from "../commands/claim.ts"
import { heartbeatCommand, HEARTBEAT_HELP } from "../commands/heartbeat.ts"
import { completeCommand, COMPLETE_HELP } from "../commands/complete.ts"
import { failCommand, FAIL_HELP } from "../commands/fail.ts"
import { artifactAddCommand, ARTIFACT_ADD_HELP } from "../commands/artifact.ts"
import { tailCommand, TAIL_HELP } from "../commands/tail.ts"

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
    case "run":
    case "run:register":
      return RUN_REGISTER_HELP
    case "run:end":
      return RUN_END_HELP
    case "enqueue":
      return ENQUEUE_HELP
    case "claim":
      return CLAIM_HELP
    case "heartbeat":
      return HEARTBEAT_HELP
    case "complete":
      return COMPLETE_HELP
    case "fail":
      return FAIL_HELP
    case "artifact":
    case "artifact:add":
      return ARTIFACT_ADD_HELP
    case "inspect":
    case "inspect:scope":
    case "inspect:run":
    case "inspect:task":
      return INSPECT_HELP
    case "tail":
      return TAIL_HELP
    default:
      return HELP_TEXT
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const dispatch = (
  args: ParsedArgs,
): Effect.Effect<void, PithosError, DbService | IdService | FsService | OutputService> =>
  Effect.gen(function* () {
    switch (args.command) {
      case "version": {
        const output = yield* OutputService
        yield* output.print(VERSION)
        break
      }

      case "help": {
        const output = yield* OutputService
        yield* output.print(helpFor(args.topic))
        break
      }

      case "init":
        yield* initCommand
        break

      case "scope:upsert":
        yield* scopeUpsertCommand({ kind: args.kind, path: args.path })
        break

      case "run:register":
        yield* runRegisterCommand({
          agentKind: args.agentKind,
          scopeId: args.scopeId,
          cwd: args.cwd,
          sessionId: args.sessionId,
          parentRun: args.parentRun,
          run: args.run,
        })
        break

      case "run:end":
        yield* runEndCommand({
          run: args.run,
          status: args.status,
          summary: args.summary,
        })
        break

      case "artifact:add":
        yield* artifactAddCommand({
          task: args.task,
          run: args.run,
          kind: args.kind,
          title: args.title,
          bodyFile: args.bodyFile,
        })
        break

      case "inspect:scope":
        yield* inspectScopeCommand(args.id)
        break

      case "inspect:run":
        yield* inspectRunCommand(args.id)
        break

      case "inspect:task":
        yield* inspectTaskCommand(args.id)
        break

      case "enqueue":
        yield* enqueueCommand({
          scope: args.scope,
          capability: args.capability,
          title: args.title,
          body: args.body,
          bodyFile: args.bodyFile,
          run: args.run,
          parentId: args.parentId,
        })
        break

      case "claim":
        yield* claimCommand({
          run: args.run,
          scope: args.scope,
          capability: args.capability,
          leaseMinutes: args.leaseMinutes,
        })
        break

      case "heartbeat":
        yield* heartbeatCommand({
          run: args.run,
          task: args.task,
          token: args.token,
          hook: args.hook,
          throttleSeconds: args.throttleSeconds,
        })
        break

      case "complete":
        yield* completeCommand({
          taskId: args.taskId,
          run: args.run,
          token: args.token,
          resultFile: args.resultFile,
        })
        break

      case "fail":
        yield* failCommand({
          taskId: args.taskId,
          run: args.run,
          token: args.token,
          reason: args.reason,
        })
        break

      case "tail":
        yield* tailCommand({ limit: args.limit })
        break

      case "unknown": {
        const cmd = args.raw[0] ?? "(none)"
        yield* Effect.fail(
          new PithosError({ code: "USER_ERROR", message: `Unknown command: ${cmd}` }),
        )
        break
      }
    }
  })
