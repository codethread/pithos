import { Effect, Layer } from "effect"
import { DbService } from "../services/db.ts"
import type { DbRow } from "../services/db.ts"
import { PithosError } from "../errors/errors.ts"

const NOT_IMPLEMENTED = new PithosError({
  code: "USER_ERROR",
  message: "DbService not yet implemented — run task 4 (pithos init).",
})

/** Placeholder live layer — replaced by real SQLite in task 4. */
export const DbServiceLive: Layer.Layer<DbService> = Layer.succeed(DbService, {
  query: () => Effect.fail(NOT_IMPLEMENTED),
  run: () => Effect.fail(NOT_IMPLEMENTED),
  transaction: () => Effect.fail(NOT_IMPLEMENTED),
})

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
          new PithosError({ code: "USER_ERROR", message: `Transaction failed: ${String(e)}` }),
      }),
  })
}
