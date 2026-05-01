import { Effect, Layer } from "effect"
import { spawn } from "node:child_process"
import { ProcessService } from "../services/process.ts"
import type { ProcessResult } from "../services/process.ts"
import { PithosError } from "../errors/errors.ts"

const spawnProcess = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string> },
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []

    proc.stdout?.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) outChunks.push(chunk)
    })
    proc.stderr?.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) errChunks.push(chunk)
    })

    proc.on("error", (err) => {
      reject(err)
    })
    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      })
    })
  })

export const ProcessServiceLive: Layer.Layer<ProcessService> = Layer.succeed(ProcessService, {
  exec: (command, args, options) =>
    Effect.tryPromise({
      try: () => spawnProcess(command, args, options ?? {}),
      catch: (e) =>
        new PithosError({
          code: "USER_ERROR",
          message: `Process execution failed: ${String(e)}`,
        }),
    }),
})

export const makeProcessServiceTest = (
  responses: readonly ProcessResult[],
): Layer.Layer<ProcessService> => {
  let idx = 0
  return Layer.succeed(ProcessService, {
    exec: () =>
      Effect.sync(() => {
        const result = responses[idx] ?? { exitCode: 0, stdout: "", stderr: "" }
        idx += 1
        return result
      }),
  })
}
