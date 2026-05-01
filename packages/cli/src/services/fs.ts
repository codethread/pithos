import { Context, type Effect } from "effect"
import type { PithosError } from "../errors/errors.ts"

export class FsService extends Context.Tag("@pithos/FsService")<
  FsService,
  {
    readonly readFile: (path: string) => Effect.Effect<string, PithosError>
    readonly writeFile: (path: string, content: string) => Effect.Effect<void, PithosError>
    readonly exists: (path: string) => Effect.Effect<boolean>
    readonly mkdir: (
      path: string,
      options?: { readonly recursive?: boolean },
    ) => Effect.Effect<void, PithosError>
  }
>() {}
