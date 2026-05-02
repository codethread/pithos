import { Cli, Command, Option, UsageError } from "clipanion"
import { Effect, Schema } from "effect"
import type { ScopeKind } from "../domain/scope.ts"
import { ScopeKindSchema } from "../domain/scope.ts"
import { PithosError } from "../errors/errors.ts"
import { VERSION } from "../version.ts"

export type ParsedArgs =
  | { command: "version" }
  | { command: "help"; topic?: string }
  | { command: "init" }
  | { command: "scope:upsert"; kind: ScopeKind; path: string | undefined }
  | { command: "run:register"; agentKind: string | undefined; scopeId: string | undefined; cwd: string | undefined; sessionId: string | undefined; parentRun: string | undefined; run: string | undefined }
  | { command: "run:end"; run: string | undefined; status: string | undefined; summary: string | undefined }
  | { command: "enqueue"; scope: string | undefined; capability: string | undefined; title: string | undefined; body: string | undefined; bodyFile: string | undefined; run: string | undefined; parentId: string | undefined }
  | { command: "claim"; run: string | undefined; scope: string | undefined; capability: string | undefined; leaseMinutes: number | undefined }
  | { command: "heartbeat"; run: string | undefined; task: string | undefined; token: number | undefined; hook: string | undefined; throttleSeconds: number | undefined }
  | { command: "complete"; taskId: string | undefined; run: string | undefined; token: number | undefined; resultFile: string | undefined }
  | { command: "fail"; taskId: string | undefined; run: string | undefined; token: number | undefined; reason: string | undefined }
  | { command: "artifact:add"; task: string | undefined; run: string | undefined; kind: string | undefined; title: string | undefined; bodyFile: string | undefined }
  | { command: "inspect:scope"; id: string }
  | { command: "inspect:run"; id: string }
  | { command: "inspect:task"; id: string }
  | { command: "tail"; limit: number | undefined }
  | { command: "sweep"; leaseGraceSeconds: number | undefined; runStaleMinutes: number | undefined }
  | { command: "briefing"; agent: string | undefined }
  | { command: "unknown"; raw: readonly string[] }

abstract class PithosCliCommand extends Command { execute(): Promise<void> { return Promise.resolve() } }
class RootCommand extends PithosCliCommand { static override paths = [Command.Default] }
class VersionCommand extends PithosCliCommand { static override paths = [["--version"], ["-v"]] }
class InitCommand extends PithosCliCommand { static override paths = [["init"]] }
class ScopeCommand extends PithosCliCommand { static override paths = [["scope"]] }
class ScopeUpsertCommand extends PithosCliCommand { static override paths = [["scope", "upsert"]]; kind = Option.String("--kind"); pathValue = Option.String("--path") }
class RunCommand extends PithosCliCommand { static override paths = [["run"]] }
class RunRegisterCommand extends PithosCliCommand { static override paths = [["run", "register"]]; agentKind = Option.String("--agent-kind"); scopeId = Option.String("--scope"); cwd = Option.String("--cwd"); sessionId = Option.String("--session-id"); parentRun = Option.String("--parent-run"); run = Option.String("--run") }
class RunEndCommand extends PithosCliCommand { static override paths = [["run", "end"]]; run = Option.String("--run"); status = Option.String("--status"); summary = Option.String("--summary") }
class EnqueueCommand extends PithosCliCommand { static override paths = [["enqueue"]]; scope = Option.String("--scope"); capability = Option.String("--capability"); title = Option.String("--title"); body = Option.String("--body"); bodyFile = Option.String("--body-file"); run = Option.String("--run"); parentId = Option.String("--parent-id") }
class ClaimCommand extends PithosCliCommand { static override paths = [["claim"]]; run = Option.String("--run"); scope = Option.String("--scope"); capability = Option.String("--capability"); leaseMinutes = Option.String("--lease-minutes") }
class HeartbeatCommand extends PithosCliCommand { static override paths = [["heartbeat"]]; run = Option.String("--run"); task = Option.String("--task"); token = Option.String("--token"); hook = Option.String("--hook"); throttleSeconds = Option.String("--throttle-seconds") }
class CompleteCommand extends PithosCliCommand { static override paths = [["complete"]]; taskId = Option.String({ required: false }); run = Option.String("--run"); token = Option.String("--token"); resultFile = Option.String("--result-file") }
class FailCommand extends PithosCliCommand { static override paths = [["fail"]]; taskId = Option.String({ required: false }); run = Option.String("--run"); token = Option.String("--token"); reason = Option.String("--reason") }
class ArtifactCommand extends PithosCliCommand { static override paths = [["artifact"]] }
class ArtifactAddCommand extends PithosCliCommand { static override paths = [["artifact", "add"]]; task = Option.String("--task"); run = Option.String("--run"); kind = Option.String("--kind"); title = Option.String("--title"); bodyFile = Option.String("--body-file") }
class InspectCommand extends PithosCliCommand { static override paths = [["inspect"]] }
class InspectScopeCommand extends PithosCliCommand { static override paths = [["inspect", "scope"]]; id = Option.String({ required: true }) }
class InspectRunCommand extends PithosCliCommand { static override paths = [["inspect", "run"]]; id = Option.String({ required: true }) }
class InspectTaskCommand extends PithosCliCommand { static override paths = [["inspect", "task"]]; id = Option.String({ required: true }) }
class TailCommand extends PithosCliCommand { static override paths = [["tail"]]; limit = Option.String("--limit") }
class SweepCommand extends PithosCliCommand { static override paths = [["sweep"]]; leaseGraceSeconds = Option.String("--lease-grace-seconds"); runStaleMinutes = Option.String("--run-stale-minutes") }
class BriefingCommand extends PithosCliCommand { static override paths = [["briefing"]]; agent = Option.String("--agent") }

const cli = Cli.from([
  RootCommand, VersionCommand, InitCommand, ScopeCommand, ScopeUpsertCommand, RunCommand, RunRegisterCommand,
  RunEndCommand, EnqueueCommand, ClaimCommand, HeartbeatCommand, CompleteCommand, FailCommand, ArtifactCommand,
  ArtifactAddCommand, InspectCommand, InspectScopeCommand, InspectRunCommand, InspectTaskCommand, TailCommand,
  SweepCommand, BriefingCommand,
], { binaryName: "pithos", binaryVersion: VERSION })

const helpArgs = (topic: string | undefined): ParsedArgs =>
  topic === undefined ? { command: "help" } : { command: "help", topic }

const helpTopicByPath = (path: readonly string[]): string | undefined => path.join(":") || undefined

const commandPaths = [
  ["scope", "upsert"], ["run", "register"], ["run", "end"], ["artifact", "add"], ["inspect", "scope"],
  ["inspect", "run"], ["inspect", "task"], ["init"], ["scope"], ["run"], ["enqueue"], ["claim"], ["heartbeat"],
  ["complete"], ["fail"], ["artifact"], ["inspect"], ["tail"], ["sweep"], ["briefing"],
] as const

const helpTopicByArgv = (argv: readonly string[]): string | undefined => {
  const allowsOperand = new Set(["inspect:scope", "inspect:run", "inspect:task", "complete", "fail"])
  for (const path of commandPaths) {
    if (!path.every((part, index) => argv[index] === part)) continue
    const topic = path.join(":")
    let operandCount = 0
    let valid = true
    for (let index = path.length; index < argv.length; index += 1) {
      const token = argv[index]
      if (token === undefined || token === "--help" || token === "-h") break
      if (token.startsWith("-")) {
        index += 1
        continue
      }
      operandCount += 1
      if (!allowsOperand.has(topic) || operandCount > 1) {
        valid = false
        break
      }
    }
    if (valid) return topic
  }
  return undefined
}

const normalizeArgv = (argv: readonly string[]): string[] => {
  const valueFlags = new Set([
    "--kind", "--path", "--agent-kind", "--scope", "--cwd", "--session-id", "--parent-run", "--run", "--status",
    "--summary", "--capability", "--title", "--body", "--body-file", "--hook", "--result-file", "--reason", "--task",
    "--agent", "--parent-id", "--lease-minutes", "--token", "--throttle-seconds", "--limit", "--lease-grace-seconds",
    "--run-stale-minutes",
  ])
  const normalized: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = argv[index + 1]
    if (token === undefined) continue
    if (valueFlags.has(token) && (next === undefined || next.startsWith("-"))) continue
    normalized.push(token)
  }
  return normalized
}

const IntFromString = Schema.NumberFromString.pipe(Schema.int())

const parseIntegerOption = (raw: string | undefined, flag: string): Effect.Effect<number | undefined, PithosError> =>
  raw === undefined ? Effect.succeed(undefined) : Schema.decodeUnknown(IntFromString)(raw).pipe(
    Effect.mapError(() => new PithosError({ code: "VALIDATION_ERROR", message: `${flag} must be an integer, got: '${raw}'` })),
  )

const parseScopeKind = (raw: string | undefined): Effect.Effect<ScopeKind, PithosError> =>
  raw === undefined ? Effect.succeed("repo") : Schema.decodeUnknown(ScopeKindSchema)(raw).pipe(
    Effect.mapError(() => new PithosError({ code: "VALIDATION_ERROR", message: `Invalid --kind value: '${raw}'. Valid values: global, repo, worktree` })),
  )

export const parseArgs = (argv: readonly string[]): Effect.Effect<ParsedArgs, PithosError> =>
  Effect.gen(function* () {
    const [first] = argv
    if (first === undefined || first === "--help" || first === "-h" || first === "help") return { command: "help" }
    if (first === "--version" || first === "-v") return { command: "version" }
    if (argv.includes("--help") || argv.includes("-h")) {
      const topic = helpTopicByArgv(argv)
      return topic === undefined ? { command: "unknown", raw: argv } : helpArgs(topic)
    }

    let command: Command
    try {
      command = cli.process(normalizeArgv(argv), {})
    } catch (error) {
      if (error instanceof UsageError) {
        return yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: error.message }))
      }
      return { command: "unknown", raw: argv } as const
    }

    if (command.help || command instanceof RootCommand) return helpArgs(helpTopicByPath(command.path))
    if (command instanceof VersionCommand) return { command: "version" } as const
    if (command instanceof InitCommand) return { command: "init" } as const
    if (command instanceof ScopeCommand) return { command: "help", topic: "scope" } as const
    if (command instanceof ScopeUpsertCommand) return { command: "scope:upsert", kind: yield* parseScopeKind(command.kind), path: command.pathValue } as const
    if (command instanceof RunCommand) return { command: "help", topic: "run" } as const
    if (command instanceof RunRegisterCommand) return { command: "run:register", agentKind: command.agentKind, scopeId: command.scopeId, cwd: command.cwd, sessionId: command.sessionId, parentRun: command.parentRun, run: command.run } as const
    if (command instanceof RunEndCommand) return { command: "run:end", run: command.run, status: command.status, summary: command.summary } as const
    if (command instanceof EnqueueCommand) return { command: "enqueue", scope: command.scope, capability: command.capability, title: command.title, body: command.body, bodyFile: command.bodyFile, run: command.run, parentId: command.parentId } as const
    if (command instanceof ClaimCommand) return { command: "claim", run: command.run, scope: command.scope, capability: command.capability, leaseMinutes: yield* parseIntegerOption(command.leaseMinutes, "--lease-minutes") } as const
    if (command instanceof HeartbeatCommand) return { command: "heartbeat", run: command.run, task: command.task, token: yield* parseIntegerOption(command.token, "--token"), hook: command.hook, throttleSeconds: yield* parseIntegerOption(command.throttleSeconds, "--throttle-seconds") } as const
    if (command instanceof CompleteCommand) return { command: "complete", taskId: command.taskId, run: command.run, token: yield* parseIntegerOption(command.token, "--token"), resultFile: command.resultFile } as const
    if (command instanceof FailCommand) return { command: "fail", taskId: command.taskId, run: command.run, token: yield* parseIntegerOption(command.token, "--token"), reason: command.reason } as const
    if (command instanceof ArtifactCommand) return { command: "help", topic: "artifact" } as const
    if (command instanceof ArtifactAddCommand) return { command: "artifact:add", task: command.task, run: command.run, kind: command.kind, title: command.title, bodyFile: command.bodyFile } as const
    if (command instanceof InspectCommand) return { command: "help", topic: "inspect" } as const
    if (command instanceof InspectScopeCommand) return { command: "inspect:scope", id: command.id } as const
    if (command instanceof InspectRunCommand) return { command: "inspect:run", id: command.id } as const
    if (command instanceof InspectTaskCommand) return { command: "inspect:task", id: command.id } as const
    if (command instanceof TailCommand) return { command: "tail", limit: yield* parseIntegerOption(command.limit, "--limit") } as const
    if (command instanceof SweepCommand) return { command: "sweep", leaseGraceSeconds: yield* parseIntegerOption(command.leaseGraceSeconds, "--lease-grace-seconds"), runStaleMinutes: yield* parseIntegerOption(command.runStaleMinutes, "--run-stale-minutes") } as const
    if (command instanceof BriefingCommand) return { command: "briefing", agent: command.agent } as const
    return { command: "unknown", raw: argv } as const
  })
