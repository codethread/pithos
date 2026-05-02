import { Context, Effect, Layer } from "effect"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DbService } from "../services/db.ts"
import type { DbRow } from "../services/db.ts"
import { PithosError } from "../errors/errors.ts"
import { resolveDbPath } from "../db/connection.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const wrapSqlError = (e: unknown): PithosError =>
  e instanceof PithosError
    ? e
    : new PithosError({
        // SQL/driver failures are infrastructure faults, not user mistakes.
        // Classifying as INTERNAL_ERROR preserves correct triage and retry policy.
        code: "INTERNAL_ERROR",
        message: `DB error: ${e instanceof Error ? e.message : "unexpected DB failure"}`,
      })

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

/**
 * Creates a live SQLite DbService layer backed by @effect/sql-sqlite-node.
 *
 * The parent directory is created before the connection is opened.
 * Foreign-key enforcement is enabled on the underlying connection.
 * The SqliteClient scope is tied to the DbService scope so the connection
 * is closed when the layer is released (process exit / test teardown).
 */
export const makeDbServiceLive = (dbPath: string): Layer.Layer<DbService, PithosError> =>
  Layer.scoped(
    DbService,
    Effect.gen(function* () {
      // 1. Ensure the parent directory exists before opening the file.
      yield* Effect.try({
        try: () => mkdirSync(dirname(dbPath), { recursive: true }),
        catch: (e) =>
          new PithosError({ code: "INTERNAL_ERROR", message: `DB mkdir error: ${e instanceof Error ? e.message : "mkdir failed"}` }),
      })

      // 2. Build the SqliteClient layer scoped to this layer's lifetime.
      //    Layer.build returns Effect<Context<...>, E, Scope>; the Scope
      //    is provided by Layer.scoped so the connection closes on release.
      const sqliteCtx = yield* Layer.build(
        SqliteClient.layer({ filename: dbPath }).pipe(
          Layer.mapError(
            (e) => new PithosError({ code: "INTERNAL_ERROR", message: `DB open error: ${e instanceof Error ? e.message : "open failed"}` }),
          ),
        ),
      )
      const sql = Context.get(sqliteCtx, SqlClient.SqlClient)

      // 3. Enable foreign-key enforcement on the underlying connection.
      //    PRAGMA foreign_keys = ON is a per-connection setting.
      yield* sql.unsafe("PRAGMA foreign_keys = ON").pipe(
        Effect.mapError(wrapSqlError),
      )

      return {
        query: (sqlStr, params) =>
          // params cast: @effect/sql expects Primitive[] at the library boundary;
          // our interface accepts unknown[] since all command values are valid SQLite
          // primitives (string | number | null). The cast is intentional here.
          sql.unsafe<DbRow>(sqlStr, params as never).pipe(
            Effect.mapError(wrapSqlError),
          ),

        run: (sqlStr, params) =>
          sql.unsafe(sqlStr, params as never).pipe(
            Effect.asVoid,
            Effect.mapError(wrapSqlError),
          ),

        withTransaction: (effect) =>
          sql.withTransaction(effect).pipe(
            Effect.mapError(wrapSqlError),
          ),
      }
    }),
  )

/**
 * Convenience live layer using the default/env-configured DB path.
 * Prefer `makeDbServiceLive(path)` in tests for isolation.
 */
export const DbServiceLive: Layer.Layer<DbService, PithosError> = makeDbServiceLive(resolveDbPath())

// ---------------------------------------------------------------------------
// Test helpers (kept in this module for co-location)
// ---------------------------------------------------------------------------

/**
 * Fake DbService for unit tests.
 *
 * `query` returns seeded rows keyed by the raw SQL string (params ignored).
 * `run` is a no-op (returns void).
 * `withTransaction` runs the inner Effect directly with no real transaction.
 *
 * This allows fast unit tests of command validation/logic without SQLite.
 */
export const makeDbServiceTest = (
  seedRows: ReadonlyMap<string, readonly DbRow[]> = new Map(),
): Layer.Layer<DbService> => {
  const rowStore = new Map(seedRows)

  return Layer.succeed(DbService, {
    query: (sql) => Effect.sync(() => rowStore.get(sql) ?? []),
    run: () => Effect.void,
    // No-op transaction: runs the effect without BEGIN/COMMIT/ROLLBACK.
    // Unit tests use this to verify logic without a real SQLite connection.
    withTransaction: (effect) => effect,
  })
}
