import { Command, Option, Cli, Builtins } from "clipanion"
import { Effect } from "effect"
import * as t from "typanion"

const writeJson = (stream, command, payload) =>
  Effect.sync(() => {
    stream.write(`${JSON.stringify({ command, ...payload }, null, 2)}\n`)
  })

class ScopeUpsertCommand extends Command {
  static paths = [["scope", "upsert"]]

  static usage = Command.Usage({
    category: "Scope",
    description: "Register or update a scope",
    details: "Tests nested subcommands, choices, defaults, and generated help.",
    examples: [["Upsert a repo scope", "$0 scope upsert --kind repo --path ~/work/project"]],
  })

  kind = Option.String("--kind", "repo", {
    description: "Scope kind",
    validator: t.isEnum(["global", "repo", "worktree"]),
  })
  path = Option.String("--path", { description: "Scope path", required: false })

  async execute() {
    await Effect.runPromise(
      writeJson(this.context.stdout, "scope:upsert", {
        kind: this.kind,
        path: this.path,
      }),
    )
  }
}

class RunRegisterCommand extends Command {
  static paths = [["run", "register"]]

  static usage = Command.Usage({
    category: "Run",
    description: "Register a run",
    examples: [["Register envy", "$0 run register --agent-kind envy --scope repo:work/demo"]],
  })

  agentKind = Option.String("--agent-kind", { description: "Agent kind", required: true })
  scope = Option.String("--scope", { description: "Scope id", required: true })

  async execute() {
    await Effect.runPromise(
      writeJson(this.context.stdout, "run:register", {
        agentKind: this.agentKind,
        scope: this.scope,
      }),
    )
  }
}

class ArtifactAddCommand extends Command {
  static paths = [["artifact", "add"]]

  static usage = Command.Usage({
    category: "Artifact",
    description: "Attach an artifact",
    examples: [["Attach report", "$0 artifact add --task task_1 --run run_1 --kind worker-completion --title Report --body-file report.md"]],
  })

  task = Option.String("--task", { required: true })
  run = Option.String("--run", { required: true })
  kind = Option.String("--kind", { required: true })
  title = Option.String("--title", { required: true })
  bodyFile = Option.String("--body-file", { required: true })

  async execute() {
    await Effect.runPromise(
      writeJson(this.context.stdout, "artifact:add", {
        task: this.task,
        run: this.run,
        kind: this.kind,
        title: this.title,
        bodyFile: this.bodyFile,
      }),
    )
  }
}

class InspectTaskCommand extends Command {
  static paths = [["inspect", "task"]]

  static usage = Command.Usage({
    category: "Inspect",
    description: "Inspect a task",
    examples: [["Inspect task", "$0 inspect task task_1"]],
  })

  id = Option.String({ name: "task-id" })

  async execute() {
    await Effect.runPromise(writeJson(this.context.stdout, "inspect:task", { id: this.id }))
  }
}

class ClaimCommand extends Command {
  static paths = [["claim"]]

  static usage = Command.Usage({
    category: "Task",
    description: "Claim one queued task",
    examples: [["Claim work", "$0 claim --run run_1 --scope repo:work/demo --capability worker"]],
  })

  run = Option.String("--run", { required: true })
  scope = Option.String("--scope", { required: true })
  capability = Option.String("--capability", { required: true })
  // Verified in the spike run: "7" is accepted and exposed as a number;
  // "1.5" is rejected before execute() runs.
  leaseMinutes = Option.String("--lease-minutes", {
    required: false,
    validator: t.cascade(t.isNumber(), t.isInteger()),
  })

  async execute() {
    await Effect.runPromise(
      writeJson(this.context.stdout, "claim", {
        run: this.run,
        scope: this.scope,
        capability: this.capability,
        leaseMinutes: this.leaseMinutes === undefined ? undefined : Number(this.leaseMinutes),
      }),
    )
  }
}

class CompleteCommand extends Command {
  static paths = [["complete"]]

  static usage = Command.Usage({
    category: "Task",
    description: "Complete a claimed task",
    details: "Tests positional args plus Effect execution inside a Clipanion command.",
    examples: [["Complete task", "$0 complete task_1 --run run_1 --token 7"]],
  })

  taskId = Option.String({ name: "task-id" })
  run = Option.String("--run", { required: true })
  // Verified in the spike run: "7" is accepted and exposed as a number;
  // "1.5" is rejected before execute() runs.
  token = Option.String("--token", {
    required: true,
    validator: t.cascade(t.isNumber(), t.isInteger()),
  })

  async execute() {
    await Effect.runPromise(
      writeJson(this.context.stdout, "complete", {
        taskId: this.taskId,
        run: this.run,
        token: Number(this.token),
      }),
    )
    return 0
  }
}

const cli = Cli.from(
  [
    Builtins.HelpCommand,
    Builtins.VersionCommand,
    ScopeUpsertCommand,
    RunRegisterCommand,
    ArtifactAddCommand,
    InspectTaskCommand,
    ClaimCommand,
    CompleteCommand,
  ],
  {
    binaryLabel: "Pithos Clipanion Spike",
    binaryName: "pithos",
    binaryVersion: "0.0.0-spike",
  },
)

const exitCode = await cli.run(process.argv.slice(2))
process.exitCode = exitCode
