import { Context, type Effect } from "effect"
import type { PithosError } from "../errors/errors.ts"

export type DbRow = Record<string, unknown>

/**
 * Placeholder DB service — full SQLite implementation added in task 4.
 * Defines the interface that commands depend on so tests can inject fakes now.
 */
export class DbService extends Context.Tag("@pithos/DbService")<
  DbService,
  {
    readonly query: (
      sql: string,
      params?: readonly unknown[],
    ) => Effect.Effect<readonly DbRow[], PithosError>
    readonly run: (
      sql: string,
      params?: readonly unknown[],
    ) => Effect.Effect<
      { readonly changes: number; readonly lastInsertRowid: number | bigint },
      PithosError
    >
    readonly transaction: <A>(fn: () => A) => Effect.Effect<A, PithosError>
  }
>() {}
