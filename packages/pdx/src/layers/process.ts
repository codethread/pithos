import { Effect, Layer } from "effect"
import { spawn } from "node:child_process"
import { PdxError } from "../errors.ts"
import { ProcessService } from "../services/process.ts"
import type { ProcessResult } from "../services/process.ts"

const spawnProcess = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string },
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv | undefined =
      opts.env !== undefined ? { ...process.env, ...opts.env } : undefined
    const proc = spawn(command, [...args], {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []

    proc.stdout?.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) outChunks.push(chunk)
    })
    proc.stderr?.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) errChunks.push(chunk)
    })
    proc.on("error", reject)
    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      })
    })

    if (opts.stdin !== undefined) {
      proc.stdin?.write(opts.stdin)
    }
    proc.stdin?.end()
  })

export const ProcessServiceLive: Layer.Layer<ProcessService> = Layer.succeed(ProcessService, {
  exec: (command, args, options) =>
    Effect.tryPromise({
      try: () => spawnProcess(command, args, options ?? {}),
      catch: (error) =>
        new PdxError({
          code: "USER_ERROR",
          message: `Process execution failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    }),
  probePid: (pid) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
          return false
        }

        throw new PdxError({
          code: "USER_ERROR",
          message: `Failed to probe pid ${pid}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }),
  signalPid: (pid, signal) =>
    Effect.try({
      try: () => {
        process.kill(pid, signal)
      },
      catch: (error) => {
        throw new PdxError({
          code: "USER_ERROR",
          message: `Failed to send ${signal} to pid ${pid}: ${error instanceof Error ? error.message : String(error)}`,
        })
      },
    }),
})
