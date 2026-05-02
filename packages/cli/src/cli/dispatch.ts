import { Effect } from "effect"
import type { ParsedArgs } from "./args.ts"
import { PithosError } from "../errors/errors.ts"
import type { DbService } from "../services/db.ts"
import type { IdService } from "../services/ids.ts"
import type { FsService } from "../services/fs.ts"
import { OutputService } from "../services/output.ts"
import { VERSION } from "../version.ts"
import { initCommand } from "../commands/init.ts"
import { scopeUpsertCommand } from "../commands/scope.ts"
import { inspectScopeCommand, inspectRunCommand, inspectTaskCommand } from "../commands/inspect.ts"
import { runRegisterCommand, runEndCommand } from "../commands/run.ts"
import { enqueueCommand } from "../commands/enqueue.ts"
import { claimCommand } from "../commands/claim.ts"
import { heartbeatCommand } from "../commands/heartbeat.ts"
import { completeCommand } from "../commands/complete.ts"
import { failCommand } from "../commands/fail.ts"
import { artifactAddCommand } from "../commands/artifact.ts"
import { tailCommand } from "../commands/tail.ts"
import { sweepCommand } from "../commands/sweep.ts"
import { briefingCommand } from "../commands/briefing.ts"

import { helpFor } from "./help.ts"

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

      case "sweep":
        yield* sweepCommand({
          leaseGraceSeconds: args.leaseGraceSeconds,
          runStaleMinutes: args.runStaleMinutes,
        })
        break

      case "briefing":
        yield* briefingCommand({ agent: args.agent })
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
