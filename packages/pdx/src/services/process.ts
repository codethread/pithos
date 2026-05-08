import { Context, type Effect } from "effect"
import type { PdxError } from "../errors.ts"

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export class ProcessService extends Context.Tag("@pithos/pdx/ProcessService")<
  ProcessService,
  {
    readonly exec: (
      command: string,
      args: readonly string[],
      options?: {
        readonly env?: Record<string, string>
        readonly cwd?: string
        readonly stdin?: string
      },
    ) => Effect.Effect<ProcessResult, PdxError>
    readonly probePid: (pid: number) => Effect.Effect<boolean, PdxError>
    readonly signalPid: (pid: number, signal: NodeJS.Signals) => Effect.Effect<void, PdxError>
  }
>() {}
