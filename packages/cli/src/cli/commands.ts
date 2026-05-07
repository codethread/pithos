/**
 * Declarative CLI command tree for Pithos using @effect/cli.
 *
 * This module replaces the hand-written parseArgs + dispatch pair with
 * a fully-declarative command tree. Each command carries rich help metadata
 * (description, examples, exit codes) so agents can discover usage from
 * `pithos --help` or `pithos <command> --help`.
 */
import { Args, Command, HelpDoc, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { initCommand } from "../commands/init.ts"
import { scopeUpsertCommand } from "../commands/scope.ts"
import {
  decodeInspectGraphSelector,
  inspectGraphCommand,
  inspectScopeCommand,
  inspectRunCommand,
  inspectTaskCommand,
} from "../commands/inspect.ts"
import { runRegisterCommand, runEndCommand } from "../commands/run.ts"
import { enqueueCommand } from "../commands/enqueue.ts"
import { supersedeCommand } from "../commands/supersede.ts"
import { claimCommand } from "../commands/claim.ts"
import { heartbeatCommand } from "../commands/heartbeat.ts"
import { completeCommand } from "../commands/complete.ts"
import { failCommand } from "../commands/fail.ts"
import { artifactAddCommand } from "../commands/artifact.ts"
import { tailCommand } from "../commands/tail.ts"
import { sweepCommand } from "../commands/sweep.ts"
import { briefingCommand } from "../commands/briefing.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unwrap an Option from an optional CLI flag into T | undefined. */
const opt = <A>(o: Option.Option<A>): A | undefined => Option.getOrUndefined(o)

/** Build a consistent command description block with examples + exit codes. */
const desc = (
  summary: string,
  cmdPath: string,
  examples: readonly string[],
  exitCodesLine: string,
): HelpDoc.HelpDoc =>
  HelpDoc.blocks([
    HelpDoc.p(`${cmdPath} - ${summary}`),
    HelpDoc.p("Examples:"),
    ...examples.map((ex) => HelpDoc.p(`  ${ex}`)),
    HelpDoc.p(`Exit codes: ${exitCodesLine}`),
  ])

// ---------------------------------------------------------------------------
// pithos init
// ---------------------------------------------------------------------------

const initCmd = Command.make("init", {}, () => initCommand).pipe(
  Command.withDescription(
    desc(
      "Create DB, run migrations, ensure default global scope",
      "pithos init",
      ["PITHOS_DB=/tmp/test.sqlite pithos init"],
      "0 success | 1 DB or migration error",
    ),
  ),
)

// ---------------------------------------------------------------------------
// pithos scope upsert
// ---------------------------------------------------------------------------

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
      "pithos scope upsert",
      [
        "pithos scope upsert --path ~/work/perkbox-services/protobuf",
        "pithos scope upsert --kind global",
        "pithos scope upsert --kind worktree --path ~/work/repo/.git/worktrees/feature",
      ],
      "0 success | 2 validation error",
    ),
  ),
)

const scope = Command.make("scope").pipe(
  Command.withDescription("Manage pithos scopes"),
  Command.withSubcommands([scopeUpsert]),
)

// ---------------------------------------------------------------------------
// pithos run register / end
// ---------------------------------------------------------------------------

const runRegister = Command.make(
  "register",
  {
    agentKind: Options.text("agent-kind").pipe(
      Options.optional,
      Options.withDescription("Agent kind identifier, e.g. envy, toil, pandora"),
    ),
    scopeId: Options.text("scope").pipe(
      Options.optional,
      Options.withDescription("Scope ID to associate with this run"),
    ),
    cwd: Options.text("cwd").pipe(
      Options.optional,
      Options.withDescription("Working directory of the agent"),
    ),
    sessionId: Options.text("session-id").pipe(
      Options.optional,
      Options.withDescription("External session ID (e.g. Claude session)"),
    ),
    parentRun: Options.text("parent-run").pipe(
      Options.optional,
      Options.withDescription("Parent run ID if this run was spawned by another"),
    ),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription(
        "Explicit run ID (idempotent: returns existing run if already registered)",
      ),
    ),
  },
  ({ agentKind, scopeId, cwd, sessionId, parentRun, run }) =>
    runRegisterCommand({
      agentKind: opt(agentKind),
      scopeId: opt(scopeId),
      cwd: opt(cwd),
      sessionId: opt(sessionId),
      parentRun: opt(parentRun),
      run: opt(run),
    }),
).pipe(
  Command.withDescription(
    desc(
      "Register a new run and return its ID",
      "pithos run register",
      [
        "pithos run register --agent-kind envy --scope repo:work/project",
        "pithos run register --agent-kind pandora",
        "pithos run register --agent-kind envy --run run_abc  # idempotent",
      ],
      "0 success | 2 validation error",
    ),
  ),
)

const runEnd = Command.make(
  "end",
  {
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Run ID to end"),
    ),
    status: Options.choice("status", ["ended", "failed", "cancelled"] as const).pipe(
      Options.optional,
      Options.withDescription("Terminal status: ended, failed, or cancelled"),
    ),
    summary: Options.text("summary").pipe(
      Options.optional,
      Options.withDescription("Optional summary message to record with this run end"),
    ),
  },
  ({ run, status, summary }) =>
    runEndCommand({
      run: opt(run),
      status: opt(status),
      summary: opt(summary),
    }),
).pipe(
  Command.withDescription(
    desc(
      "Mark a run as ended, failed, or cancelled",
      "pithos run end",
      [
        "pithos run end --run run_abc --status ended",
        "pithos run end --run run_abc --status failed --summary 'timed out'",
      ],
      "0 success | 2 validation error | 3 not found",
    ),
  ),
)

const run = Command.make("run").pipe(
  Command.withDescription("Manage pithos runs (Claude Code / worker / agent sessions)"),
  Command.withSubcommands([runRegister, runEnd]),
)

// ---------------------------------------------------------------------------
// pithos enqueue
// ---------------------------------------------------------------------------

const enqueue = Command.make(
  "enqueue",
  {
    scope: Options.text("scope").pipe(
      Options.optional,
      Options.withDescription("Scope ID the task belongs to"),
    ),
    capability: Options.text("capability").pipe(
      Options.optional,
      Options.withDescription("Capability label for matching workers, e.g. triage, watch"),
    ),
    title: Options.text("title").pipe(
      Options.optional,
      Options.withDescription("Short human-readable title for the task"),
    ),
    body: Options.text("body").pipe(
      Options.optional,
      Options.withDescription("Inline task body text (mutually exclusive with --body-file)"),
    ),
    bodyFile: Options.text("body-file").pipe(
      Options.optional,
      Options.withDescription("Path to a file containing the task body"),
    ),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Run ID of the agent enqueuing the task"),
    ),
    dependsOn: Options.text("depends-on").pipe(
      Options.repeated,
      Options.withDescription("Direct dependency target task ID; repeat for multiple blockers"),
    ),
  },
  ({ scope, capability, title, body, bodyFile, run, dependsOn }) =>
    enqueueCommand({
      scope: opt(scope),
      capability: opt(capability),
      title: opt(title),
      body: opt(body),
      bodyFile: opt(bodyFile),
      run: opt(run),
      dependsOn,
    }),
).pipe(
  Command.withDescription(
    desc(
      "Create a queued task with direct dependency edges and a task.created event",
      "pithos enqueue",
      [
        "pithos enqueue --scope global --capability triage --title 'Review PR #42'",
        "pithos enqueue --scope repo:work/repo --capability watch --title 'Watch build' --depends-on task_design --depends-on task_api",
      ],
      "0 success | 1 user error | 2 validation error | 3 not found",
    ),
  ),
)

// ---------------------------------------------------------------------------
// pithos supersede
// ---------------------------------------------------------------------------

const supersede = Command.make(
  "supersede",
  {
    taskId: Args.text({ name: "task-id" }),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Run ID performing the supersession [required]"),
    ),
    reason: Options.text("reason").pipe(
      Options.optional,
      Options.withDescription("Human-readable supersession reason [required]"),
    ),
    title: Options.text("title").pipe(
      Options.optional,
      Options.withDescription("Replacement task title (defaults to the old task title)"),
    ),
    body: Options.text("body").pipe(
      Options.optional,
      Options.withDescription("Inline replacement task body text (mutually exclusive with --body-file)"),
    ),
    bodyFile: Options.text("body-file").pipe(
      Options.optional,
      Options.withDescription("Path to a file containing the replacement task body"),
    ),
    scope: Options.text("scope").pipe(
      Options.optional,
      Options.withDescription("Replacement scope ID (defaults to the old task scope)"),
    ),
    capability: Options.text("capability").pipe(
      Options.optional,
      Options.withDescription("Replacement capability (defaults to the old task capability)"),
    ),
  },
  ({ taskId, run, reason, title, body, bodyFile, scope, capability }) =>
    supersedeCommand({
      taskId,
      run: opt(run),
      reason: opt(reason),
      title: opt(title),
      body: opt(body),
      bodyFile: opt(bodyFile),
      scope: opt(scope),
      capability: opt(capability),
    }),
).pipe(
  Command.withDescription(
    desc(
      "Replace a task with a fresh queued task and record supersession history",
      "pithos supersede",
      [
        "pithos supersede task_api --run run_pandora --reason 'Wrong interface; replacing with corrected task'",
        "pithos supersede task_api --run run_pandora --reason 'Need repo-local fix' --scope repo:work/repo --capability build --title 'Fix API contract'",
      ],
      "0 success | 1 user error | 2 validation error | 3 not found",
    ),
  ),
)

// ---------------------------------------------------------------------------
// pithos claim
// ---------------------------------------------------------------------------

const claim = Command.make(
  "claim",
  {
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Run ID claiming the task [required]"),
    ),
    scope: Options.text("scope").pipe(
      Options.optional,
      Options.withDescription("Scope ID to search within [required]"),
    ),
    capability: Options.text("capability").pipe(
      Options.optional,
      Options.withDescription("Capability label to match [required]"),
    ),
    leaseMinutes: Options.integer("lease-minutes").pipe(
      Options.optional,
      Options.withDescription("Lease duration in minutes (default: 10)"),
    ),
  },
  ({ run, scope, capability, leaseMinutes }) =>
    claimCommand({
      run: opt(run),
      scope: opt(scope),
      capability: opt(capability),
      leaseMinutes: opt(leaseMinutes),
    }),
).pipe(
  Command.withDescription(
    desc(
      "Atomically claim the oldest ready queued task for a run",
      "pithos claim",
      [
        "pithos claim --run run_abc --scope global --capability triage",
        "pithos claim --run run_abc --scope repo:work/repo --capability watch --lease-minutes 15",
      ],
      "0 success with fencing_token in output | 2 validation error | 5 no ready work",
    ),
  ),
)

// ---------------------------------------------------------------------------
// pithos heartbeat
// ---------------------------------------------------------------------------

const heartbeat = Command.make(
  "heartbeat",
  {
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Run ID to heartbeat [required]"),
    ),
    task: Options.text("task").pipe(
      Options.optional,
      Options.withDescription("Task ID to advance to running (requires --token)"),
    ),
    token: Options.integer("token").pipe(
      Options.optional,
      Options.withDescription("Fencing token from claim (required when --task is provided)"),
    ),
    hook: Options.text("hook").pipe(
      Options.optional,
      Options.withDescription(
        "Claude hook context: SessionStart, Stop, StopFailure, or SessionEnd",
      ),
    ),
    throttleSeconds: Options.integer("throttle-seconds").pipe(
      Options.optional,
      Options.withDescription(
        "Skip heartbeat if last heartbeat was within this many seconds (idempotent)",
      ),
    ),
  },
  ({ run, task, token, hook, throttleSeconds }) =>
    heartbeatCommand({
      run: opt(run),
      task: opt(task),
      token: opt(token),
      hook: opt(hook),
      throttleSeconds: opt(throttleSeconds),
    }),
).pipe(
  Command.withDescription(
    desc(
      "Update run heartbeat; optionally advance task to running",
      "pithos heartbeat",
      [
        "pithos heartbeat --run run_abc",
        "pithos heartbeat --run run_abc --task task_xyz --token 3",
        "pithos heartbeat --run $PITHOS_RUN_ID --hook SessionStart --throttle-seconds 60",
      ],
      "0 success | 2 validation error | 3 not found | 4 stale token",
    ),
  ),
)

// ---------------------------------------------------------------------------
// pithos complete
// ---------------------------------------------------------------------------

const complete = Command.make(
  "complete",
  {
    taskId: Args.text({ name: "task-id" }),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Run ID that owns the task [required]"),
    ),
    token: Options.integer("token").pipe(
      Options.optional,
      Options.withDescription("Fencing token from claim [required]"),
    ),
    resultFile: Options.text("result-file").pipe(
      Options.optional,
      Options.withDescription("Path to a JSON file containing the task result"),
    ),
  },
  ({ taskId, run, token, resultFile }) =>
    completeCommand({
      taskId,
      run: opt(run),
      token: opt(token),
      resultFile: opt(resultFile),
    }),
).pipe(
  Command.withDescription(
    desc(
      "Complete a claimed task (requires matching fencing token)",
      "pithos complete",
      [
        "pithos complete task_abc --run run_xyz --token 3",
        "pithos complete task_abc --run run_xyz --token 3 --result-file result.json",
      ],
      "0 success | 2 validation error | 4 stale token",
    ),
  ),
)

// ---------------------------------------------------------------------------
// pithos fail
// ---------------------------------------------------------------------------

const fail = Command.make(
  "fail",
  {
    taskId: Args.text({ name: "task-id" }),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Run ID that owns the task [required]"),
    ),
    token: Options.integer("token").pipe(
      Options.optional,
      Options.withDescription("Fencing token from claim [required]"),
    ),
    reason: Options.text("reason").pipe(
      Options.optional,
      Options.withDescription("Human-readable reason for failure"),
    ),
  },
  ({ taskId, run, token, reason }) =>
    failCommand({
      taskId,
      run: opt(run),
      token: opt(token),
      reason: opt(reason),
    }),
).pipe(
  Command.withDescription(
    desc(
      "Fail a claimed task (requires matching fencing token)",
      "pithos fail",
      [
        "pithos fail task_abc --run run_xyz --token 3",
        "pithos fail task_abc --run run_xyz --token 3 --reason 'upstream timeout'",
      ],
      "0 success | 2 validation error | 4 stale token",
    ),
  ),
)

// ---------------------------------------------------------------------------
// pithos artifact add
// ---------------------------------------------------------------------------

const artifactAdd = Command.make(
  "add",
  {
    task: Options.text("task").pipe(
      Options.optional,
      Options.withDescription("Task ID to attach the artifact to [required]"),
    ),
    run: Options.text("run").pipe(
      Options.optional,
      Options.withDescription("Run ID producing the artifact [required]"),
    ),
    kind: Options.text("kind").pipe(
      Options.optional,
      Options.withDescription("Artifact kind, e.g. worker-completion, design-brief [required]"),
    ),
    title: Options.text("title").pipe(
      Options.optional,
      Options.withDescription("Human-readable title for the artifact [required]"),
    ),
    bodyFile: Options.text("body-file").pipe(
      Options.optional,
      Options.withDescription("Path to file containing the artifact body"),
    ),
  },
  ({ task, run, kind, title, bodyFile }) =>
    artifactAddCommand({
      task: opt(task),
      run: opt(run),
      kind: opt(kind),
      title: opt(title),
      bodyFile: opt(bodyFile),
    }),
).pipe(
  Command.withDescription(
    desc(
      "Attach a completion report, design brief, or status artifact to a task",
      "pithos artifact add",
      [
        "pithos artifact add --task task_abc --run run_xyz --kind worker-completion --title 'Done' --body-file report.md",
      ],
      "0 success | 2 validation error | 3 not found",
    ),
  ),
)

const artifact = Command.make("artifact").pipe(
  Command.withDescription("Manage pithos artifacts"),
  Command.withSubcommands([artifactAdd]),
)

// ---------------------------------------------------------------------------
// pithos inspect scope / run / task
// ---------------------------------------------------------------------------

const inspectScope = Command.make(
  "scope",
  { id: Args.text({ name: "scope-id" }) },
  ({ id }) => inspectScopeCommand(id),
).pipe(
  Command.withDescription(
    desc(
      "Inspect a scope by ID",
      "pithos inspect scope",
      ["pithos inspect scope global", "pithos inspect scope repo:work/perkbox-services/protobuf"],
      "0 success | 3 not found",
    ),
  ),
)

const inspectRun = Command.make(
  "run",
  { id: Args.text({ name: "run-id" }) },
  ({ id }) => inspectRunCommand(id),
).pipe(
  Command.withDescription(
    desc(
      "Inspect a run by ID",
      "pithos inspect run",
      ["pithos inspect run run_abc123"],
      "0 success | 3 not found",
    ),
  ),
)

const inspectTask = Command.make(
  "task",
  { id: Args.text({ name: "task-id" }) },
  ({ id }) => inspectTaskCommand(id),
).pipe(
  Command.withDescription(
    desc(
      "Inspect a task by ID with dependencies, dependents, blockers, supersession links, and artifacts",
      "pithos inspect task",
      ["pithos inspect task task_abc123"],
      "0 success | 3 not found",
    ),
  ),
)

const inspectGraph = Command.make(
  "graph",
  {
    task: Options.text("task").pipe(
      Options.optional,
      Options.withDescription("Seed task ID for closed transitive graph inspection"),
    ),
    scope: Options.text("scope").pipe(
      Options.optional,
      Options.withDescription("Seed scope ID; starts from all non-cancelled tasks in that scope"),
    ),
    all: Options.boolean("all").pipe(
      Options.withDescription("Inspect all non-cancelled tasks across all scopes"),
    ),
    current: Options.boolean("current").pipe(
      Options.withDescription("Deprecated alias for --all"),
    ),
    flat: Options.boolean("flat").pipe(
      Options.withDescription("Render a plain-text tree (opt-in text mode; hides completed chains by default)"),
    ),
    dump: Options.boolean("dump").pipe(
      Options.withDescription("Show all chains including completed ones (only meaningful with --flat)"),
    ),
  },
  ({ task, scope, all, current, flat, dump }) =>
    decodeInspectGraphSelector({ taskId: opt(task), scopeId: opt(scope), all, current }).pipe(
      Effect.flatMap((selector) => inspectGraphCommand(selector, flat, dump)),
    ),
).pipe(
  Command.withDescription(
    HelpDoc.blocks([
      HelpDoc.p("pithos inspect graph - Inspect a closed transitive dependency/supersession graph"),
      HelpDoc.p("Choose exactly one selector: --task <id>, --scope <scope-id>, or --all."),
      HelpDoc.p("Output (default JSON, machine-readable):"),
      HelpDoc.p(
        '  { "ok": true, "graph": { "selector": { "kind": "task", "value": "task_..." } | { "kind": "scope", "value": "repo:..." } | { "kind": "current" }, "nodes": [ { "id": "...", "scope_id": "...", "capability": "...", "status": "...", "title": "...", "claimable": false, "unresolved_dependency_ids": [ ... ], "supersedes_task_id": null, "superseded_by_task_id": null } ], "edges": [ { "kind": "depends_on", "from_task_id": "...", "to_task_id": "...", "satisfied": true }, { "kind": "supersedes", "from_task_id": "...", "to_task_id": "..." } ] } }',
      ),
      HelpDoc.p("Output with --flat (plain-text supersession-chain tree, human/agent-readable prose):"),
      HelpDoc.p("  [status] task title"),
      HelpDoc.p("    [status] replacement task title"),
      HelpDoc.p("      [status] next replacement ..."),
      HelpDoc.p("Examples:"),
      HelpDoc.p("  pithos inspect graph --task task_abc123"),
      HelpDoc.p("  pithos inspect graph --scope repo:work/perkbox-services/protobuf"),
      HelpDoc.p("  pithos inspect graph --all"),
      HelpDoc.p("  pithos inspect graph --all --flat"),
      HelpDoc.p("  pithos inspect graph --all --flat --dump"),
      HelpDoc.p("Exit codes: 0 success | 2 validation error | 3 not found"),
    ]),
  ),
)

const inspect = Command.make("inspect").pipe(
  Command.withDescription(
    HelpDoc.blocks([
      HelpDoc.p("Inspect persisted state: scope, run, task, or graph."),
      HelpDoc.p("Task inspection includes direct dependencies, direct dependents, unresolved blockers, and immediate supersession links."),
      HelpDoc.p("Graph inspection returns a closed transitive dependency/supersession graph for one task, one scope, or all non-cancelled work."),
      HelpDoc.p("Examples:"),
      HelpDoc.p("  pithos inspect scope global"),
      HelpDoc.p("  pithos inspect run run_abc"),
      HelpDoc.p("  pithos inspect task task_abc"),
      HelpDoc.p("  pithos inspect graph --task task_abc"),
      HelpDoc.p("  pithos inspect graph --scope repo:work/repo"),
      HelpDoc.p("  pithos inspect graph --all"),
      HelpDoc.p("Exit codes: 0 success | 2 validation error | 3 not found"),
    ]),
  ),
  Command.withSubcommands([inspectScope, inspectRun, inspectTask, inspectGraph]),
)

// ---------------------------------------------------------------------------
// pithos tail
// ---------------------------------------------------------------------------

const tail = Command.make(
  "tail",
  {
    limit: Options.integer("limit").pipe(
      Options.optional,
      Options.withDescription("Maximum number of events to return (default: 20)"),
    ),
  },
  ({ limit }) => tailCommand({ limit: opt(limit) }),
).pipe(
  Command.withDescription(
    HelpDoc.blocks([
      HelpDoc.p("pithos tail - Show recent events for debugging and graph-history audit"),
      HelpDoc.p("Graph-history payloads in payload_json:"),
      HelpDoc.p("  task.created     => scope_id, capability, title, depends_on_task_ids, optional supersedes_task_id"),
      HelpDoc.p("  task.cancelled   => reason, superseded_by_task_id"),
      HelpDoc.p("  task.superseded  => new_task_id, reason, retargeted_dependent_task_ids"),
      HelpDoc.p("Examples:"),
      HelpDoc.p("  pithos tail"),
      HelpDoc.p("  pithos tail --limit 100"),
      HelpDoc.p("  pithos tail --limit 100  # inspect task.created/task.cancelled/task.superseded payloads"),
      HelpDoc.p("Exit codes: 0 success | 2 validation error"),
    ]),
  ),
)

// ---------------------------------------------------------------------------
// pithos sweep
// ---------------------------------------------------------------------------

const sweep = Command.make(
  "sweep",
  {
    leaseGraceSeconds: Options.integer("lease-grace-seconds").pipe(
      Options.optional,
      Options.withDescription("Seconds of grace after lease expiry before requeue (default: 0)"),
    ),
    runStaleMinutes: Options.integer("run-stale-minutes").pipe(
      Options.optional,
      Options.withDescription("Minutes of silence before a run is considered stale (default: 15)"),
    ),
  },
  ({ leaseGraceSeconds, runStaleMinutes }) =>
    sweepCommand({
      leaseGraceSeconds: opt(leaseGraceSeconds),
      runStaleMinutes: opt(runStaleMinutes),
    }),
).pipe(
  Command.withDescription(
    desc(
      "Expire stale leases, mark stale runs, requeue eligible tasks",
      "pithos sweep",
      [
        "pithos sweep",
        "pithos sweep --lease-grace-seconds 30 --run-stale-minutes 60",
      ],
      "0 success | 2 validation error | 1 DB error",
    ),
  ),
)

// ---------------------------------------------------------------------------
// pithos briefing
// ---------------------------------------------------------------------------

const briefing = Command.make(
  "briefing",
  {
    agent: Options.text("agent").pipe(
      Options.optional,
      Options.withDescription("Agent name requesting the briefing (e.g. pandora)"),
    ),
  },
  ({ agent }) => briefingCommand({ agent: opt(agent) }),
).pipe(
  Command.withDescription(
    desc(
      "Render Pandora briefing markdown with ready vs blocked queued work",
      "pithos briefing",
      [
        "pithos briefing --agent pandora",
      ],
      "0 success | 2 validation error",
    ),
  ),
)

// ---------------------------------------------------------------------------
// Root: pithos
// ---------------------------------------------------------------------------

/**
 * Root pithos command.
 *
 * The description includes environment variables and exit codes so agents
 * can always find them via `pithos --help`.
 */
export const pithosCommand = Command.make("pithos").pipe(
  Command.withDescription(
    HelpDoc.blocks([
      HelpDoc.p("Local control plane for coordinating Claude Code agents."),
      HelpDoc.p("Environment:"),
      HelpDoc.p("  PITHOS_DB             SQLite DB path (default: ~/.pandora/pithos.sqlite)"),
      HelpDoc.p("  PITHOS_RUN_ID         Current run ID for hooks/agents"),
      HelpDoc.p("  PITHOS_TASK_ID        Current claimed task ID"),
      HelpDoc.p("  PITHOS_FENCING_TOKEN  Current task claim token"),
      HelpDoc.p("  PITHOS_SCOPE_ID       Scope hint for current session"),
      HelpDoc.p("  PITHOS_OUTPUT         Output format: json or text (default: json)"),
      HelpDoc.p("Exit codes:"),
      HelpDoc.p("  0  Success"),
      HelpDoc.p("  1  General/user error"),
      HelpDoc.p("  2  Validation error"),
      HelpDoc.p("  3  Not found"),
      HelpDoc.p("  4  Stale lease/fencing token"),
      HelpDoc.p("  5  No claimable work"),
    ]),
  ),
  Command.withSubcommands([
    initCmd,
    scope,
    run,
    enqueue,
    supersede,
    claim,
    heartbeat,
    complete,
    fail,
    artifact,
    inspect,
    tail,
    sweep,
    briefing,
  ]),
)
