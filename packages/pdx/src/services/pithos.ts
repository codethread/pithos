import { Context, type Effect } from "effect"
import type { PdxError } from "../errors.ts"

export interface RunOutput {
  readonly id: string
  readonly agent: string
  readonly mode: string
  readonly scope_id: string
  readonly status: string
  readonly task_id: string | null
  readonly session_id: string
  readonly created_at: string
  readonly updated_at: string
}

export class PithosClient extends Context.Tag("@pithos/pdx/PithosClient")<
  PithosClient,
  {
    readonly init: () => Effect.Effect<void, PdxError>
    readonly upsertSystemRun: (input: {
      readonly home: string
      readonly runId: string
      readonly sessionId: string
    }) => Effect.Effect<RunOutput, PdxError>
    readonly cleanupRun: (input: {
      readonly runId: string
      readonly reason: string
    }) => Effect.Effect<RunOutput, PdxError>
  }
>() {}
