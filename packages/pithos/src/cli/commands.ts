import { Args, Command, HelpDoc, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { artifactAddCommand } from "../commands/artifact.ts"
import { briefingCommand } from "../commands/briefing.ts"
import { cancelCommand } from "../commands/cancel.ts"
import { claimCommand } from "../commands/claim.ts"
import { completeCommand } from "../commands/complete.ts"
import { enqueueCommand } from "../commands/enqueue.ts"
import { failCommand } from "../commands/fail.ts"
import { heartbeatCommand } from "../commands/heartbeat.ts"
import { initCommand } from "../commands/init.ts"
import {
  decodeInspectGraphSelector,
  inspectGraphCommand,
  inspectRunCommand,
  inspectTaskCommand,
} from "../commands/inspect.ts"
import {
  runCleanupCommand,
  runInterruptCommand,
  runTimeoutCommand,
  runUpsertCommand,
} from "../commands/run.ts"
import { scopeUpsertCommand } from "../commands/scope.ts"
import { supersedeCommand } from "../commands/supersede.ts"
import { tailCommand } from "../commands/tail.ts"
import { AGENT_KINDS, CAPABILITIES, RUN_MODES } from "../domain/control-plane.ts"
import { resolveMutatingTaskRunId } from "../domain/run.ts"

const opt = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value)

const desc = (
  summary: string,
  cmdPath: string,
  examples: readonly string[],
  exitCodesLine: string,
): HelpDoc.HelpDoc =>
  HelpDoc.blocks([
    HelpDoc.p(`${cmdPath} - ${summary}`),
    HelpDoc.p("Examples:"),
    ...examples.map((example) => HelpDoc.p(`  ${example}`)),
    HelpDoc.p(`Exit codes: ${exitCodesLine}`),
  ])

const initCmd = Command.make(
  "init",
  {
    fresh: Options.boolean("fresh").pipe(
      Options.withDescription("Drop the existing pithos-next schema before re-initialising"),
    ),
  },
  ({ fresh }) => initCommand({ fresh }),
).pipe(
  Command.withDescription(
    desc(
      "Create or reset the pithos-next SQLite store and seed built-ins",
      "pithos-next init",
      ["pithos-next init", "pithos-next init --fresh"],
      "0 success | 1 general error",
    ),
  ),
)

const scopeUpsert = Command.make(
  "upsert",
  {
    kind: Options.choice("kind", ["global", "repo", "worktree"] as const).pipe(
      Options.withDefault("repo" as const),
      Options.withDescription("Scope kind: global, repo, or worktree"),
    ),
    path: Options.text("path").pipe(
      Options.optional,
      Options.withDescription("Filesystem path (required for repo/worktree kinds)"),
    ),
  },
  ({ kind, path }) => scopeUpsertCommand({ kind, path: opt(path) }),
).pipe(
  Command.withDescription(
    desc(
      "Register or update a scope",
      "pithos-next scope upsert",
      [
        "pithos-next scope upsert --kind global",
        "pithos-next scope upsert --kind repo --path ~/work/repo",
      ],
      "0 success | 2 validation error",
    ),
  ),
)

const scope = Command.make("scope").pipe(
  Command.withDescription("Manage scopes"),
  Command.withSubcommands([scopeUpsert]),
)

const runUpsert = Command.make(
  "upsert",
  {
    agent: Options.choice("agent", AGENT_KINDS).pipe(
      Options.withDescription("Run agent kind"),
    ),
    mode: Options.choice("mode", RUN_MODES).pipe(
      Options.withDescription("Run mode: afk or hitl"),
    ),
    scope: Options.text("scope").pipe(Options.withDescription("Registered scope id")),
    cwd: Options.text("cwd").pipe(Options.withDescription("Working directory for the run")),
    sessionId: Options.text("session-id").pipe(
      Options.withDescription("Harness session id for audit/debug visibility"),
    ),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Explicit run id; generates one when omitted"),
    ),
  },
  ({ agent, mode, scope, cwd, sessionId, run }) =>
    runUpsertCommand({
      agent,
      mode,
      scope,
      cwd,
      sessionId,
      run: opt(run),
    }),
).pipe(
  Command.withDescription(
    desc(
      "Create or update a run row",
      "pithos-next run upsert",
      [
        "pithos-next run upsert --agent toil --mode afk --scope global --cwd $PWD --session-id session_1",
      ],
      "0 success | 2 validation error | 3 not found",
    ),
  ),
)

const runInspect = Command.make(
  "inspect",
  { id: Args.text({ name: "run-id" }) },
  ({ id }) => inspectRunCommand(id),
).pipe(
  Command.withDescription(
    desc(
      "Inspect one run",
      "pithos-next run inspect",
      ["pithos-next run inspect run_abc123"],
      "0 success | 3 not found",
    ),
  ),
)

const runCleanup = Command.make(
  "cleanup",
  {
    run: Options.text("run").pipe(Options.withDescription("Run id to clean up")),
    reason: Options.text("reason").pipe(Options.withDescription("Cleanup reason")),
  },
  ({ run, reason }) => runCleanupCommand({ run, reason }),
).pipe(
  Command.withDescription(
    desc(
      "Finalize natural lifecycle cleanup after execution is confirmed gone",
      "pithos-next run cleanup",
      ["pithos-next run cleanup --run run_war --reason 'daemon_start'"],
      "0 success | 2 validation error | 3 not found | 4 stale token",
    ),
  ),
)

const runInterrupt = Command.make(
  "interrupt",
  {
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Run id to interrupt"),
    ),
    task: Options.text("task").pipe(
      Options.optional,
      Options.withDescription("Held task id whose owning run should be interrupted"),
    ),
    reason: Options.text("reason").pipe(Options.withDescription("Interruption reason")),
  },
  ({ run, task, reason }) =>
    runInterruptCommand({ run: opt(run), task: opt(task), reason }),
).pipe(
  Command.withDescription(
    desc(
      "Interrupt a run or the live run holding a task",
      "pithos-next run interrupt",
      [
        "pithos-next run interrupt --run run_war --reason 'wrong repo'",
        "pithos-next run interrupt --task task_abc --reason 'operator kill'",
      ],
      "0 success | 1 user error | 2 validation error | 3 not found | 4 stale token",
    ),
  ),
)

const runTimeout = Command.make(
  "timeout",
  {
    run: Options.text("run").pipe(Options.withDescription("Run id to time out")),
    reason: Options.text("reason").pipe(Options.withDescription("Timeout reason")),
  },
  ({ run, reason }) => runTimeoutCommand({ run, reason }),
).pipe(
  Command.withDescription(
    desc(
      "Mark a no-claim run as timed out",
      "pithos-next run timeout",
      ["pithos-next run timeout --run run_toil --reason 'no claim in 30s'"],
      "0 success | 2 validation error | 3 not found",
    ),
  ),
)

const run = Command.make("run").pipe(
  Command.withDescription("Manage runs"),
  Command.withSubcommands([runUpsert, runCleanup, runInterrupt, runTimeout, runInspect]),
)

const taskEnqueue = Command.make(
  "enqueue",
  {
    scope: Options.text("scope").pipe(Options.withDescription("Scope id for the new task")),
    capability: Options.choice("capability", CAPABILITIES).pipe(
      Options.withDescription("Capability required to execute the task"),
    ),
    title: Options.text("title").pipe(Options.withDescription("Task title")),
    body: Options.text("body").pipe(
      Options.optional,
      Options.withDescription("Inline task body (mutually exclusive with --body-file)"),
    ),
    bodyFile: Options.text("body-file").pipe(
      Options.optional,
      Options.withDescription("Task body file path (mutually exclusive with --body)"),
    ),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Actor run id; defaults from PITHOS_RUN_ID"),
    ),
    dependsOn: Options.text("depends-on").pipe(
      Options.repeated,
      Options.withDescription("Direct dependency task id; repeat for multiple blockers"),
    ),
  },
  ({ scope, capability, title, body, bodyFile, run, dependsOn }) =>
    resolveMutatingTaskRunId(opt(run)).pipe(
      Effect.flatMap((resolvedRun) =>
        enqueueCommand({
          scope,
          capability,
          title,
          body: opt(body),
          bodyFile: opt(bodyFile),
          run: resolvedRun,
          dependsOn,
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    desc(
      "Create a queued task",
      "pithos-next task enqueue",
      [
        "pithos-next task enqueue --scope global --capability escalate --title 'Need review' --body 'Review the latest execution result' --run run_pandora",
        "pithos-next task enqueue --scope repo:work/repo --capability execute --title 'Implement fix' --body-file task.md --depends-on task_design --run run_toil",
      ],
      "0 success | 1 user error | 2 validation error | 3 not found",
    ),
  ),
)

const taskClaim = Command.make(
  "claim",
  {
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Claiming run id; defaults from PITHOS_RUN_ID"),
    ),
    scope: Options.text("scope").pipe(Options.withDescription("Scope to search within")),
    capability: Options.choice("capability", CAPABILITIES).pipe(
      Options.withDescription("Capability to claim"),
    ),
  },
  ({ run, scope, capability }) =>
    resolveMutatingTaskRunId(opt(run)).pipe(
      Effect.flatMap((resolvedRun) =>
        claimCommand({ run: resolvedRun, scope, capability }),
      ),
    ),
).pipe(
  Command.withDescription(
    desc(
      "Atomically claim the oldest ready queued task",
      "pithos-next task claim",
      ["pithos-next task claim --run run_war --scope repo:work/repo --capability execute"],
      "0 success | 1 user error | 2 validation error | 3 not found | 5 no claimable work",
    ),
  ),
)

const taskHeartbeat = Command.make(
  "heartbeat",
  {
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Run id; defaults from PITHOS_RUN_ID"),
    ),
    task: Options.text("task").pipe(
      Options.optional,
      Options.withDescription("Held task id to advance from claimed to running"),
    ),
    token: Options.integer("token").pipe(
      Options.optional,
      Options.withDescription("Fencing token for the held task"),
    ),
  },
  ({ run, task, token }) =>
    resolveMutatingTaskRunId(opt(run)).pipe(
      Effect.flatMap((resolvedRun) =>
        heartbeatCommand({ run: resolvedRun, task: opt(task), token: opt(token) }),
      ),
    ),
).pipe(
  Command.withDescription(
    desc(
      "Record liveness; optionally advance a held task to running",
      "pithos-next task heartbeat",
      [
        "pithos-next task heartbeat --run run_toil",
        "pithos-next task heartbeat --run run_war --task task_abc --token 1",
      ],
      "0 success | 2 validation error | 3 not found | 4 stale token",
    ),
  ),
)

const taskComplete = Command.make(
  "complete",
  {
    taskId: Args.text({ name: "task-id" }),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Owning run id; defaults from PITHOS_RUN_ID"),
    ),
    token: Options.integer("token").pipe(Options.withDescription("Fencing token")),
    resultFile: Options.text("result-file").pipe(
      Options.optional,
      Options.withDescription("JSON result file"),
    ),
  },
  ({ taskId, run, token, resultFile }) =>
    resolveMutatingTaskRunId(opt(run)).pipe(
      Effect.flatMap((resolvedRun) =>
        completeCommand({
          taskId,
          run: resolvedRun,
          token,
          resultFile: opt(resultFile),
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    desc(
      "Mark a held task as done",
      "pithos-next task complete",
      ["pithos-next task complete task_abc --run run_war --token 1 --result-file result.json"],
      "0 success | 2 validation error | 4 stale token",
    ),
  ),
)

const taskFail = Command.make(
  "fail",
  {
    taskId: Args.text({ name: "task-id" }),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Owning run id; defaults from PITHOS_RUN_ID"),
    ),
    token: Options.integer("token").pipe(Options.withDescription("Fencing token")),
    reason: Options.text("reason").pipe(Options.withDescription("Failure reason")),
  },
  ({ taskId, run, token, reason }) =>
    resolveMutatingTaskRunId(opt(run)).pipe(
      Effect.flatMap((resolvedRun) =>
        failCommand({ taskId, run: resolvedRun, token, reason }),
      ),
    ),
).pipe(
  Command.withDescription(
    desc(
      "Mark a held task as failed",
      "pithos-next task fail",
      ["pithos-next task fail task_abc --run run_war --token 1 --reason 'tests failed'"],
      "0 success | 2 validation error | 4 stale token",
    ),
  ),
)

const taskSupersede = Command.make(
  "supersede",
  {
    taskId: Args.text({ name: "task-id" }),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Actor run id; defaults from PITHOS_RUN_ID"),
    ),
    reason: Options.text("reason").pipe(Options.withDescription("Supersession reason")),
    title: Options.text("title").pipe(
      Options.optional,
      Options.withDescription("Replacement title"),
    ),
    body: Options.text("body").pipe(
      Options.optional,
      Options.withDescription("Replacement body (mutually exclusive with --body-file)"),
    ),
    bodyFile: Options.text("body-file").pipe(
      Options.optional,
      Options.withDescription("Replacement body file (mutually exclusive with --body)"),
    ),
    scope: Options.text("scope").pipe(
      Options.optional,
      Options.withDescription("Replacement scope id"),
    ),
    capability: Options.choice("capability", CAPABILITIES).pipe(
      Options.optional,
      Options.withDescription("Replacement capability"),
    ),
  },
  ({ taskId, run, reason, title, body, bodyFile, scope, capability }) =>
    resolveMutatingTaskRunId(opt(run)).pipe(
      Effect.flatMap((resolvedRun) =>
        supersedeCommand({
          taskId,
          run: resolvedRun,
          reason,
          title: opt(title),
          body: opt(body),
          bodyFile: opt(bodyFile),
          scope: opt(scope),
          capability: opt(capability),
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    desc(
      "Replace a task with a fresh queued task and preserve history",
      "pithos-next task supersede",
      ["pithos-next task supersede task_old --run run_pandora --reason 'Wrong scope' --scope global --capability escalate"],
      "0 success | 1 user error | 2 validation error | 3 not found",
    ),
  ),
)

const taskCancel = Command.make(
  "cancel",
  {
    taskId: Args.text({ name: "task-id" }),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Actor run id; defaults from PITHOS_RUN_ID"),
    ),
    reason: Options.text("reason").pipe(Options.withDescription("Cancellation reason")),
  },
  ({ taskId, run, reason }) =>
    resolveMutatingTaskRunId(opt(run)).pipe(
      Effect.flatMap((resolvedRun) => cancelCommand({ taskId, run: resolvedRun, reason })),
    ),
).pipe(
  Command.withDescription(
    desc(
      "Cancel queued, failed, or dead-lettered work",
      "pithos-next task cancel",
      ["pithos-next task cancel task_old --run run_pandora --reason 'No longer needed'"],
      "0 success | 1 user error | 2 validation error | 3 not found",
    ),
  ),
)

const taskInspect = Command.make(
  "inspect",
  { id: Args.text({ name: "task-id" }) },
  ({ id }) => inspectTaskCommand(id),
).pipe(
  Command.withDescription(
    desc(
      "Inspect one task with dependencies, dependents, blockers, supersession links, and artifacts",
      "pithos-next task inspect",
      ["pithos-next task inspect task_abc123"],
      "0 success | 3 not found",
    ),
  ),
)

const taskArtifactAdd = Command.make(
  "add",
  {
    task: Options.text("task").pipe(Options.withDescription("Task id to attach the artifact to")),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Actor run id; defaults from PITHOS_RUN_ID"),
    ),
    kind: Options.text("kind").pipe(Options.withDescription("Artifact kind")),
    title: Options.text("title").pipe(Options.withDescription("Artifact title")),
    bodyFile: Options.text("body-file").pipe(
      Options.optional,
      Options.withDescription("Artifact body file"),
    ),
  },
  ({ task, run, kind, title, bodyFile }) =>
    resolveMutatingTaskRunId(opt(run)).pipe(
      Effect.flatMap((resolvedRun) =>
        artifactAddCommand({
          task,
          run: resolvedRun,
          kind,
          title,
          bodyFile: opt(bodyFile),
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    desc(
      "Attach an artifact to a task",
      "pithos-next task artifact add",
      ["pithos-next task artifact add --task task_abc --run run_war --kind war-completion --title 'War report' --body-file report.md"],
      "0 success | 2 validation error | 3 not found",
    ),
  ),
)

const taskArtifact = Command.make("artifact").pipe(
  Command.withDescription("Manage task artifacts"),
  Command.withSubcommands([taskArtifactAdd]),
)

const task = Command.make("task").pipe(
  Command.withDescription("Manage tasks"),
  Command.withSubcommands([
    taskEnqueue,
    taskClaim,
    taskHeartbeat,
    taskComplete,
    taskFail,
    taskSupersede,
    taskCancel,
    taskInspect,
    taskArtifact,
  ]),
)

const graphInspect = Command.make(
  "inspect",
  {
    task: Options.text("task").pipe(
      Options.optional,
      Options.withDescription("Task id selector"),
    ),
    scope: Options.text("scope").pipe(
      Options.optional,
      Options.withDescription("Scope selector"),
    ),
    all: Options.boolean("all").pipe(
      Options.withDescription("Select all non-cancelled tasks"),
    ),
    flat: Options.boolean("flat").pipe(
      Options.withDescription("Render a plain-text supersession-chain tree"),
    ),
    dump: Options.boolean("dump").pipe(
      Options.withDescription("Include fully terminal chains in --flat output"),
    ),
  },
  ({ task, scope, all, flat, dump }) =>
    decodeInspectGraphSelector({ taskId: opt(task), scopeId: opt(scope), all }).pipe(
      Effect.flatMap((selector) => inspectGraphCommand(selector, flat, dump)),
    ),
).pipe(
  Command.withDescription(
    desc(
      "Inspect dependency and supersession graphs",
      "pithos-next graph inspect",
      [
        "pithos-next graph inspect --task task_abc",
        "pithos-next graph inspect --scope repo:work/repo",
        "pithos-next graph inspect --all --flat",
      ],
      "0 success | 2 validation error | 3 not found",
    ),
  ),
)

const graph = Command.make("graph").pipe(
  Command.withDescription("Inspect task graphs"),
  Command.withSubcommands([graphInspect]),
)

const eventsTail = Command.make(
  "tail",
  {
    limit: Options.integer("limit").pipe(
      Options.optional,
      Options.withDescription("Maximum number of events to return"),
    ),
  },
  ({ limit }) => tailCommand({ limit: opt(limit) }),
).pipe(
  Command.withDescription(
    desc(
      "Show recent durable events",
      "pithos-next events tail",
      ["pithos-next events tail --limit 100"],
      "0 success | 2 validation error",
    ),
  ),
)

const events = Command.make("events").pipe(
  Command.withDescription("Inspect event history"),
  Command.withSubcommands([eventsTail]),
)

const briefing = Command.make(
  "briefing",
  {
    agent: Options.text("agent").pipe(
      Options.optional,
      Options.withDescription("Briefing perspective; only pandora is supported"),
    ),
  },
  ({ agent }) => briefingCommand({ agent: opt(agent) }),
).pipe(
  Command.withDescription(
    desc(
      "Render the Pandora briefing markdown",
      "pithos-next briefing",
      ["pithos-next briefing --agent pandora"],
      "0 success | 2 validation error",
    ),
  ),
)

export const pithosCommand = Command.make("pithos-next").pipe(
  Command.withDescription(
    HelpDoc.blocks([
      HelpDoc.p("Next-generation local Pithos control plane."),
      HelpDoc.p("Environment:"),
      HelpDoc.p("  PITHOS_DB             SQLite DB path (default: ~/.pandora/pithos-next.sqlite)"),
      HelpDoc.p("  PITHOS_RUN_ID         Default run id for mutating task commands"),
      HelpDoc.p("  PITHOS_LOG_LEVEL      trace | debug | info | warning | error | fatal | none"),
      HelpDoc.p("Exit codes:"),
      HelpDoc.p("  0  Success"),
      HelpDoc.p("  1  General/user error"),
      HelpDoc.p("  2  Validation error"),
      HelpDoc.p("  3  Not found"),
      HelpDoc.p("  4  Stale fencing token"),
      HelpDoc.p("  5  No claimable work"),
    ]),
  ),
  Command.withSubcommands([initCmd, scope, run, task, graph, events, briefing]),
)
