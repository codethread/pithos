import { Effect, Layer } from "effect"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"
import { DbService } from "../services/db.ts"
import type { DbRow } from "../services/db.ts"
import { PithosError } from "../errors/errors.ts"
import { resolveDbPath } from "../db/connection.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const wrapDbError =
  (context: string) =>
  (e: unknown): PithosError =>
    new PithosError({ code: "USER_ERROR", message: `DB error (${context}): ${String(e)}` })

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

/**
 * Creates a live SQLite DbService layer backed by better-sqlite3.
 *
 * Uses `Layer.scoped` so the connection is properly closed when the scope
 * exits (process end, test teardown, etc.). The parent directory is created
 * recursively if it does not exist. Foreign-key enforcement is enabled for
 * every connection so REFERENCES constraints are actually enforced.
 */
export const makeDbServiceLive = (dbPath: string): Layer.Layer<DbService, PithosError> =>
  Layer.scoped(
    DbService,
    Effect.gen(function* () {
      // Ensure the parent directory exists before opening the file.
      yield* Effect.try({
        try: () => mkdirSync(dirname(dbPath), { recursive: true }),
        catch: wrapDbError("mkdir"),
      })

      // Acquire the DB connection; release it when the scope closes.
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const conn = new Database(dbPath)
            conn.pragma("foreign_keys = ON")
            return conn
          },
          catch: wrapDbError("open"),
        }),
        (conn) => Effect.sync(() => conn.close()),
      )

      return {
        query: (sql, params) =>
          Effect.try({
            try: () => db.prepare(sql).all(...(params ?? [])) as DbRow[],
            catch: wrapDbError(`query: ${sql.slice(0, 60)}`),
          }),

        run: (sql, params) =>
          Effect.try({
            try: () => {
              const result = db.prepare(sql).run(...(params ?? []))
              return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
            },
            catch: wrapDbError(`run: ${sql.slice(0, 60)}`),
          }),

        transaction: (fn) =>
          Effect.try({
            try: () => {
              const txDb = {
                query: (sql: string, params?: readonly unknown[]) =>
                  db.prepare(sql).all(...(params ?? [])) as DbRow[],
                run: (sql: string, params?: readonly unknown[]) => {
                  const result = db.prepare(sql).run(...(params ?? []))
                  return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
                },
              }
              return db.transaction(() => fn(txDb))()
            },
            catch: (e) => {
              if (e instanceof Error && e.message === "PITHOS_STALE_TOKEN_RACE") {
                return new PithosError({
                  code: "STALE_TOKEN",
                  message: "Stale fencing token (race condition)",
                })
              }
              // Any other throw from a transaction body signals an internal
              // invariant violation (e.g. INSERT RETURNING * returned no rows),
              // not a user mistake.  Classify as INTERNAL_ERROR so automated
              // triage and agents are not misled into treating it as user error.
              return new PithosError({
                code: "INTERNAL_ERROR",
                message: `DB integrity error (transaction): ${String(e)}`,
              })
            },
          }),
      }
    }),
  )

/**
 * Convenience live layer using the default/env-configured DB path.
 * Prefer `makeDbServiceLive(path)` in tests to control isolation.
 */
export const DbServiceLive: Layer.Layer<DbService, PithosError> = makeDbServiceLive(resolveDbPath())

// ---------------------------------------------------------------------------
// Test helpers (kept in this module for co-location)
// ---------------------------------------------------------------------------

export const makeDbServiceTest = (
  seedRows: ReadonlyMap<string, readonly DbRow[]> = new Map(),
): Layer.Layer<DbService> => {
  const rowStore = new Map(seedRows)

  return Layer.succeed(DbService, {
    query: (sql) => Effect.sync(() => rowStore.get(sql) ?? []),
    run: () => Effect.succeed({ changes: 0, lastInsertRowid: 0 }),
    transaction: (fn) =>
      Effect.try({
        try: () =>
          fn({
            query: (sql) => rowStore.get(sql) ?? [],
            run: () => ({ changes: 0, lastInsertRowid: 0 }),
          }),
        catch: (e) =>
          new PithosError({ code: "INTERNAL_ERROR", message: `Transaction failed: ${String(e)}` }),
      }),
  })
}
