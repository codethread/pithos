import { Command } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import { Context, Effect, Layer } from "effect"
import { SpawnerError } from "./errors.ts"

export interface NewSessionInput {
  readonly target: string
  readonly cwd: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface TmuxShape {
  readonly newSession: (
    input: NewSessionInput,
  ) => Effect.Effect<void, SpawnerError, CommandExecutor>
  readonly panePid: (target: string) => Effect.Effect<number | null, SpawnerError, CommandExecutor>
}

export class Tmux extends Context.Tag("@pithos/spawner/Tmux")<Tmux, TmuxShape>() {}

const launchError = (message: string): SpawnerError =>
  new SpawnerError({ code: "LAUNCH_ERROR", message })

const platformLaunchError = (message: string, error: { readonly message: string }): SpawnerError =>
  launchError(`${message}: ${error.message}`)

export const TmuxLive = Layer.succeed(Tmux, {
  newSession: ({ target, cwd, argv, env }) => {
    const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`)
    const command = Command.make(
      "tmux",
      "new-session",
      "-d",
      "-s",
      target,
      "-c",
      cwd,
      "env",
      ...envArgs,
      ...argv,
    )

    return Command.exitCode(command).pipe(
      Effect.mapError((error) => platformLaunchError(`tmux new-session failed for ${target}`, error)),
      Effect.flatMap((exitCode) =>
        exitCode === 0
          ? Effect.void
          : Effect.fail(launchError(`tmux new-session failed for ${target} with exit code ${exitCode}`)),
      ),
    )
  },
  panePid: (target) =>
    Command.string(Command.make("tmux", "list-panes", "-t", target, "-F", "#{pane_pid}"), "utf-8").pipe(
      Effect.mapError((error) => platformLaunchError(`tmux list-panes failed for ${target}`, error)),
      Effect.map((stdout) => {
        const line = stdout
          .split("\n")
          .map((value) => value.trim())
          .find((value) => value.length > 0)

        if (line === undefined) {
          return null
        }

        const pid = Number(line)
        return Number.isFinite(pid) ? pid : null
      }),
    ),
})
