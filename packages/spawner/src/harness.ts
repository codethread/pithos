import * as FileSystem from "@effect/platform/FileSystem"
import { Command } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import type { DbService } from "@pithos/pithos/src/services/db.ts"
import { Effect, ParseResult, Schema } from "effect"
import type { Scope } from "effect/Scope"
import {
  RunModeSchema,
  SpawnableAgentKindSchema,
  type RunMode,
  type SpawnableAgentKind,
} from "@pithos/pithos/src/domain/control-plane.ts"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { SpawnerError } from "./errors.ts"
import type { HarnessName } from "./harness-name.ts"
import { piExtensionDir } from "./paths.ts"
import { getPithosBin } from "./pithos-bin.ts"
import { loadTemplate, render, type TemplatePaths } from "./template.ts"
import { validateManifestAgainstSeedRows } from "./capability-matrix.ts"
import { Tmux } from "./tmux.ts"

export const RenderAgentInputSchema = Schema.Struct({
  agent: SpawnableAgentKindSchema,
  mode: RunModeSchema,
  runId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  scopeId: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
})

export type RenderAgentInput = Schema.Schema.Type<typeof RenderAgentInputSchema>

export interface RenderedAgent {
  readonly agent: SpawnableAgentKind
  readonly mode: RunMode
  readonly runId: string
  readonly sessionId: string
  readonly scopeId: string
  readonly cwd: string
  readonly logicalName: string
  readonly harness: {
    readonly kind: HarnessName
    readonly argv: readonly string[]
    readonly env: Readonly<Record<string, string>>
  }
  readonly prompt: string
}

interface LaunchResultBase {
  readonly agent: SpawnableAgentKind
  readonly mode: RunMode
  readonly runId: string
  readonly sessionId: string
  readonly scopeId: string
  readonly logicalName: string
  readonly harnessKind: HarnessName
  readonly sessionLogPath: string
}

export type LaunchResult =
  | (LaunchResultBase & {
      readonly afk: {
        readonly pid: number
        readonly processStartTime: string
      }
    })
  | (LaunchResultBase & {
      readonly hitl: {
        readonly tmuxTarget: string
        readonly panePid: number | null
      }
    })

const validationError = (message: string): SpawnerError =>
  new SpawnerError({ code: "VALIDATION_ERROR", message })

const templatePathsError = <A>(effect: Effect.Effect<A, SpawnerError, FileSystem.FileSystem | TemplatePaths>) => effect

const harnessError = (message: string): SpawnerError =>
  new SpawnerError({ code: "HARNESS_ERROR", message })

const launchError = (message: string): SpawnerError =>
  new SpawnerError({ code: "LAUNCH_ERROR", message })

const decodeInput = (raw: unknown): Effect.Effect<RenderAgentInput, SpawnerError> =>
  Schema.decodeUnknown(RenderAgentInputSchema)(raw).pipe(
    Effect.mapError(
      (error) =>
        new SpawnerError({
          code: "VALIDATION_ERROR",
          message:
            "Invalid renderAgent input\n" + ParseResult.TreeFormatter.formatErrorSync(error),
        }),
    ),
  )

const scopeSlug = (scopeId: string): string => {
  const slug = scopeId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug.toLowerCase() : "scope"
}

const sessionShort = (sessionId: string): string => {
  const slug = sessionId.replace(/[^A-Za-z0-9]+/g, "")
  return slug.length <= 8 ? slug : slug.slice(-8)
}

const logicalName = (agent: SpawnableAgentKind, scopeId: string, sessionId: string): string => {
  if (agent === "pandora") {
    return "pdx--pandora"
  }

  return `pdx--${agent}__${scopeSlug(scopeId)}--${sessionShort(sessionId)}`
}

const defaultHomeDir = (): string => {
  const home = process.env.HOME
  return home !== undefined && home.length > 0 ? home : homedir()
}

const canonicalPiSessionPath = (cwd: string, sessionId: string): string => {
  const encodedCwd = cwd.replace(/^\/+/, "").replace(/[/:\\]/g, "-")
  return join(
    process.env.PANDORA_SPAWN_PI_SESSIONS_ROOT ?? join(defaultHomeDir(), ".pi", "agent", "sessions"),
    `--${encodedCwd}--`,
    `${sessionId}.jsonl`,
  )
}

const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]+/g, "-")

const claudeSessionLogPath = (cwd: string, sessionId: string): string =>
  join(
    process.env.PANDORA_SPAWN_CLAUDE_SESSIONS_ROOT ?? join(defaultHomeDir(), ".claude", "projects"),
    claudeProjectSlug(cwd),
    `${sessionId}.jsonl`,
  )

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const harnessEnv = (input: RenderAgentInput, pithosBin: string): Readonly<Record<string, string>> => ({
  ...(process.env.PITHOS_DB !== undefined ? { PITHOS_DB: process.env.PITHOS_DB } : {}),
  ...(process.env.PITHOS_LOG_LEVEL !== undefined
    ? { PITHOS_LOG_LEVEL: process.env.PITHOS_LOG_LEVEL }
    : {}),
  PITHOS_AGENT: input.agent,
  PITHOS_BIN: pithosBin,
  PITHOS_OUTPUT: "json",
  PITHOS_RUN_ID: input.runId,
  PITHOS_SCOPE_ID: input.scopeId,
  PITHOS_SESSION_ID: input.sessionId,
})

const harnessArgv = (
  kind: HarnessName,
  prompt: string,
  input: RenderAgentInput,
): readonly string[] => {
  switch (kind) {
    case "claude":
      return [
        "claude",
        "--session-id",
        input.sessionId,
        "--dangerously-skip-permissions",
        "--system-prompt",
        prompt,
      ]
    case "pi":
      return [
        "pi",
        "--session",
        canonicalPiSessionPath(input.cwd, input.sessionId),
        "--extension",
        piExtensionDir,
        "--system-prompt",
        prompt,
      ]
  }
}

const sessionLogPath = (rendered: RenderedAgent): string => {
  switch (rendered.harness.kind) {
    case "claude":
      return claudeSessionLogPath(rendered.cwd, rendered.sessionId)
    case "pi":
      return canonicalPiSessionPath(rendered.cwd, rendered.sessionId)
  }
}

const platformErrorMessage = (message: string, error: { readonly message: string }): SpawnerError =>
  launchError(`${message}: ${error.message}`)

const executableAndArgs = (argv: readonly string[]): Effect.Effect<readonly [string, ...string[]], SpawnerError> => {
  const [executable, ...args] = argv
  if (executable === undefined) {
    return Effect.fail(harnessError("Harness argv is empty"))
  }

  return Effect.succeed([executable, ...args])
}

const ensureHarnessSessionPath = (
  rendered: RenderedAgent,
): Effect.Effect<void, SpawnerError, FileSystem.FileSystem> =>
  rendered.harness.kind === "pi"
    ? Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(dirname(sessionLogPath(rendered)), { recursive: true }).pipe(
          Effect.mapError(
            (error) =>
              new SpawnerError({
                code: "HARNESS_ERROR",
                message: `Failed to create Pi session directory: ${error.message}`,
              }),
          ),
        )
      })
    : Effect.void

export const renderAgent = (
  raw: RenderAgentInput,
): Effect.Effect<RenderedAgent, SpawnerError, FileSystem.FileSystem | TemplatePaths> =>
  templatePathsError(
    Effect.gen(function* () {
    const input = yield* decodeInput(raw)
    const loaded = yield* loadTemplate(input.agent)

    if (loaded.manifest.mode !== input.mode) {
      yield* Effect.fail(
        validationError(
          `Mode mismatch for ${input.agent}; manifest requires ${loaded.manifest.mode} but caller supplied ${input.mode}`,
        ),
      )
    }

    const claimCapability = loaded.manifest.claims[0]
    if (claimCapability === undefined) {
      return yield* Effect.fail(validationError(`${input.agent} manifest is missing a claim capability`))
    }

    const pithosBin = yield* getPithosBin
    const claimCommand = `${shellQuote(pithosBin)} task claim --run ${shellQuote(input.runId)} --scope ${shellQuote(input.scopeId)} --capability ${shellQuote(claimCapability)}`
    const prompt = yield* render(loaded.body, {
      agent: input.agent,
      mode: input.mode,
      run_id: input.runId,
      session_id: input.sessionId,
      scope_id: input.scopeId,
      cwd: input.cwd,
      pithos_bin: pithosBin,
      pithos_bin_shell: shellQuote(pithosBin),
      run_quoted: shellQuote(input.runId),
      scope_quoted: shellQuote(input.scopeId),
      claim_command: claimCommand,
    })

      return {
        agent: input.agent,
        mode: input.mode,
        runId: input.runId,
        sessionId: input.sessionId,
        scopeId: input.scopeId,
        cwd: input.cwd,
        logicalName: logicalName(input.agent, input.scopeId, input.sessionId),
        harness: {
          kind: loaded.manifest.harness.kind,
          argv: harnessArgv(loaded.manifest.harness.kind, prompt, input),
          env: harnessEnv(input, pithosBin),
        },
        prompt,
      }
    }),
  )

export const launchAgent = (
  input: RenderAgentInput,
): Effect.Effect<
  LaunchResult,
  SpawnerError,
  FileSystem.FileSystem | TemplatePaths | Tmux | CommandExecutor | DbService | Scope
> =>
  Effect.gen(function* () {
    const loaded = yield* loadTemplate(input.agent)
    yield* validateManifestAgainstSeedRows(loaded.manifest)
    const rendered = yield* renderAgent(input)
    const sessionLog = sessionLogPath(rendered)
    yield* ensureHarnessSessionPath(rendered)

      switch (rendered.mode) {
        case "afk": {
          const [executable, ...args] = yield* executableAndArgs(rendered.harness.argv)
          const process = yield* Command.start(
            Command.make(executable, ...args).pipe(
              Command.env(rendered.harness.env),
              Command.workingDirectory(rendered.cwd),
            ),
          ).pipe(
            Effect.mapError((error) => platformErrorMessage(`Failed to launch ${rendered.agent}`, error)),
          )

          return {
            agent: rendered.agent,
            mode: rendered.mode,
            runId: rendered.runId,
            sessionId: rendered.sessionId,
            scopeId: rendered.scopeId,
            logicalName: rendered.logicalName,
            harnessKind: rendered.harness.kind,
            sessionLogPath: sessionLog,
            afk: {
              pid: Number(process.pid),
              processStartTime: new Date().toISOString(),
            },
          }
        }
        case "hitl": {
          const tmux = yield* Tmux
          yield* tmux.newSession({
            target: rendered.logicalName,
            cwd: rendered.cwd,
            argv: rendered.harness.argv,
            env: rendered.harness.env,
          })
          const panePid = yield* tmux.panePid(rendered.logicalName)

          return {
            agent: rendered.agent,
            mode: rendered.mode,
            runId: rendered.runId,
            sessionId: rendered.sessionId,
            scopeId: rendered.scopeId,
            logicalName: rendered.logicalName,
            harnessKind: rendered.harness.kind,
            sessionLogPath: sessionLog,
            hitl: {
              tmuxTarget: rendered.logicalName,
              panePid,
            },
          }
        }
      }

    return yield* Effect.fail(launchError(`Unsupported mode for ${rendered.agent}`))
  })
