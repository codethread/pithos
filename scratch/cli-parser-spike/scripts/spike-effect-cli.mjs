import { Args, Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Option } from "effect"

const optionToUndefined = (value) =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: (inner) => inner,
  })

const emit = (command, payload) =>
  Console.log(JSON.stringify({ command, ...payload }, null, 2))

const scopeUpsert = Command.make(
  "upsert",
  {
    kind: Options.choice("kind", ["global", "repo", "worktree"]).pipe(
      Options.withDefault("repo"),
      Options.withDescription("Scope kind"),
    ),
    path: Options.text("path").pipe(
      Options.optional,
      Options.withDescription("Scope path"),
    ),
  },
  ({ kind, path }) =>
    emit("scope:upsert", {
      kind,
      path: optionToUndefined(path),
    }),
).pipe(Command.withDescription("Register or update a scope"))

const scope = Command.make("scope").pipe(
  Command.withDescription("Manage scopes"),
  Command.withSubcommands([scopeUpsert]),
)

const runRegister = Command.make(
  "register",
  {
    agentKind: Options.text("agent-kind").pipe(Options.withDescription("Agent kind")),
    scope: Options.text("scope").pipe(Options.withDescription("Scope id")),
  },
  ({ agentKind, scope }) =>
    emit("run:register", {
      agentKind,
      scope,
    }),
).pipe(Command.withDescription("Register a run"))

const run = Command.make("run").pipe(
  Command.withDescription("Manage runs"),
  Command.withSubcommands([runRegister]),
)

const artifactAdd = Command.make(
  "add",
  {
    task: Options.text("task"),
    run: Options.text("run"),
    kind: Options.text("kind"),
    title: Options.text("title"),
    bodyFile: Options.text("body-file"),
  },
  ({ task, run, kind, title, bodyFile }) =>
    emit("artifact:add", { task, run, kind, title, bodyFile }),
).pipe(Command.withDescription("Attach an artifact"))

const artifact = Command.make("artifact").pipe(
  Command.withDescription("Manage artifacts"),
  Command.withSubcommands([artifactAdd]),
)

const inspectTask = Command.make(
  "task",
  {
    id: Args.text({ name: "task-id" }),
  },
  ({ id }) => emit("inspect:task", { id }),
).pipe(Command.withDescription("Inspect a task"))

const inspect = Command.make("inspect").pipe(
  Command.withDescription("Inspect persisted state"),
  Command.withSubcommands([inspectTask]),
)

const claim = Command.make(
  "claim",
  {
    run: Options.text("run"),
    scope: Options.text("scope"),
    capability: Options.text("capability"),
    leaseMinutes: Options.integer("lease-minutes").pipe(Options.optional),
  },
  ({ run, scope, capability, leaseMinutes }) =>
    emit("claim", {
      run,
      scope,
      capability,
      leaseMinutes: optionToUndefined(leaseMinutes),
    }),
).pipe(Command.withDescription("Claim one queued task"))

const complete = Command.make(
  "complete",
  {
    taskId: Args.text({ name: "task-id" }),
    run: Options.text("run"),
    token: Options.integer("token"),
  },
  ({ taskId, run, token }) =>
    Effect.gen(function* () {
      yield* Effect.logDebug("effect-cli spike handler executed").pipe(
        Effect.annotateLogs({ command: "complete", taskId }),
      )
      yield* emit("complete", { taskId, run, token })
    }),
).pipe(Command.withDescription("Complete a claimed task"))

const command = Command.make("pithos").pipe(
  Command.withDescription("Pithos CLI parser spike"),
  Command.withSubcommands([scope, run, artifact, inspect, claim, complete]),
)

const cli = Command.run(command, {
  name: "Pithos Effect CLI Spike",
  version: "0.0.0-spike",
  executable: "pithos",
})

const program = cli(process.argv).pipe(Effect.provide(NodeContext.layer))

NodeRuntime.runMain(program)
