import { Context, type Effect } from "effect"
import type { PithosError } from "../errors/errors.ts"

export type DbRow = Record<string, unknown>

/**
 * Synchronous DB handle passed to a transaction body.
 * Mirrors the `better-sqlite3` synchronous API so the live layer can map
 * directly to `db.transaction(fn)()` without escaping the Effect runtime.
 */
export interface TxDb {
  readonly query: (sql: string, params?: readonly unknown[]) => readonly DbRow[]
  readonly run: (
    sql: string,
    params?: readonly unknown[],
  ) => { readonly changes: number; readonly lastInsertRowid: number | bigint }
}

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
    /**
     * Run multiple synchronous DB operations inside a single transaction.
     * The body receives a `TxDb` handle; callers must not use async operations
     * inside the body (matches `better-sqlite3`'s synchronous transaction API).
     */
    readonly transaction: <A>(fn: (tx: TxDb) => A) => Effect.Effect<A, PithosError>
  }
>() {}
