import { Effect, Layer } from "effect"
import { PdxError } from "../errors.ts"
import { ProcessService } from "../services/process.ts"
import { Tmux } from "../services/tmux.ts"

const tmuxError = (message: string): PdxError =>
  new PdxError({ code: "USER_ERROR", message })

export const TmuxLive: Layer.Layer<Tmux, never, ProcessService> = Layer.effect(
  Tmux,
  Effect.gen(function* () {
    const process = yield* ProcessService

    const runTmux = (
      args: readonly string[],
      options?: { readonly stdin?: string },
    ): Effect.Effect<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }, PdxError> =>
      process.exec("tmux", args, options?.stdin === undefined ? {} : { stdin: options.stdin })

    return {
      hasSession: (target) =>
        runTmux(["has-session", "-t", target]).pipe(
          Effect.map((result) => result.exitCode === 0),
        ),
      lsSessions: () =>
        runTmux(["ls", "-F", "#S"]).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(
                  result.stdout
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0),
                )
              : result.stderr.includes("failed to connect to server")
                ? Effect.succeed([])
                : Effect.fail(tmuxError(`tmux ls failed: ${result.stderr.trim() || "unknown tmux error"}`)),
          ),
        ),
      newSession: ({ target, cwd, argv, env, remainOnExit }) => {
        const envArgs = Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`)
        const args = ["new-session", "-d", "-s", target, "-c", cwd, "env", ...envArgs, ...argv]
        const fullArgs = remainOnExit === true
          ? [...args, ";", "set-option", "-t", target, "remain-on-exit", "on"]
          : args
        return runTmux(fullArgs).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(tmuxError(`tmux new-session failed for ${target}: ${result.stderr.trim() || "unknown tmux error"}`)),
          ),
        )
      },
      killSession: (target) =>
        runTmux(["kill-session", "-t", target]).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(tmuxError(`tmux kill-session failed for ${target}: ${result.stderr.trim() || "unknown tmux error"}`)),
          ),
        ),
      paneDead: (target) =>
        runTmux(["list-panes", "-t", target, "-F", "#{pane_dead}"]).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode !== 0) {
              return Effect.fail(tmuxError(`tmux list-panes failed for ${target}: ${result.stderr.trim() || "unknown tmux error"}`))
            }

            const values = result.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)

            return Effect.succeed(values.some((value) => value === "1"))
          }),
        ),
      capturePane: (target) =>
        runTmux(["capture-pane", "-t", target, "-p", "-S", "-", "-E", "-"]).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.stdout)
              : Effect.fail(tmuxError(`tmux capture-pane failed for ${target}: ${result.stderr.trim() || "unknown tmux error"}`)),
          ),
        ),
      setRemainOnExit: (target, enabled) =>
        runTmux(["set-option", "-t", target, "remain-on-exit", enabled ? "on" : "off"]).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(tmuxError(`tmux set-option failed for ${target}: ${result.stderr.trim() || "unknown tmux error"}`)),
          ),
        ),
      sendLiteralLine: (target, text) =>
        runTmux(["send-keys", "-t", target, "-l", text]).pipe(
          Effect.flatMap((result) =>
            result.exitCode !== 0
              ? Effect.fail(tmuxError(`tmux send-keys failed for ${target}: ${result.stderr.trim() || "unknown tmux error"}`))
              : runTmux(["send-keys", "-t", target, "Enter"]).pipe(
                  Effect.flatMap((enterResult) =>
                    enterResult.exitCode === 0
                      ? Effect.void
                      : Effect.fail(tmuxError(`tmux send-keys Enter failed for ${target}: ${enterResult.stderr.trim() || "unknown tmux error"}`)),
                  ),
                ),
          ),
        ),
      pasteBuffer: (target, content) =>
        runTmux(["load-buffer", "-"], { stdin: content }).pipe(
          Effect.flatMap((loadResult) =>
            loadResult.exitCode !== 0
              ? Effect.fail(tmuxError(`tmux load-buffer failed: ${loadResult.stderr.trim() || "unknown tmux error"}`))
              : runTmux(["paste-buffer", "-t", target]).pipe(
                  Effect.flatMap((pasteResult) =>
                    pasteResult.exitCode === 0
                      ? Effect.void
                      : Effect.fail(tmuxError(`tmux paste-buffer failed for ${target}: ${pasteResult.stderr.trim() || "unknown tmux error"}`)),
                  ),
                ),
          ),
        ),
    }
  }),
)
