import { Context, type Effect } from "effect"

export class OutputService extends Context.Tag("@pithos/pdx/OutputService")<
  OutputService,
  {
    readonly print: (line: string) => Effect.Effect<void>
    readonly printError: (line: string) => Effect.Effect<void>
  }
>() {}
