import { Context, type Effect } from "effect"
import type { PdxError } from "../errors.ts"

export class FileSystem extends Context.Tag("@pithos/pdx/FileSystem")<
  FileSystem,
  {
    readonly makeDirectory: (path: string, options?: { readonly recursive?: boolean }) => Effect.Effect<void, PdxError>
    readonly readDirectory: (path: string) => Effect.Effect<readonly string[], PdxError>
    readonly readFileString: (path: string) => Effect.Effect<string, PdxError>
    readonly removeFile: (path: string) => Effect.Effect<void, PdxError>
  }
>() {}
