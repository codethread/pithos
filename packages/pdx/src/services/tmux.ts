import { Context, type Effect } from "effect"
import type { PdxError } from "../errors.ts"

export interface NewSessionInput {
  readonly target: string
  readonly cwd: string
  readonly argv: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export class Tmux extends Context.Tag("@pithos/pdx/Tmux")<
  Tmux,
  {
    readonly hasSession: (target: string) => Effect.Effect<boolean, PdxError>
    readonly lsSessions: () => Effect.Effect<readonly string[], PdxError>
    readonly newSession: (input: NewSessionInput) => Effect.Effect<void, PdxError>
    readonly killSession: (target: string) => Effect.Effect<void, PdxError>
    readonly sendLiteralLine: (target: string, text: string) => Effect.Effect<void, PdxError>
    readonly pasteBuffer: (target: string, content: string) => Effect.Effect<void, PdxError>
  }
>() {}
