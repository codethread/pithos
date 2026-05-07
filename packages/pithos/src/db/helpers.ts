import { Effect, Schema } from "effect"
import type { PithosError } from "../errors/errors.ts"
import { PithosError as PE } from "../errors/errors.ts"
import type { DbRow } from "../services/db.ts"
import { ArtifactRow, EventRow, RunRow, ScopeRow, TaskRow } from "./rows.ts"

export interface DbLike {
  readonly query: (
    sql: string,
    params?: readonly unknown[],
  ) => Effect.Effect<readonly DbRow[], PithosError>
}

export class IdRow extends Schema.Class<IdRow>("IdRow")({
  id: Schema.String,
}) {}

export class MaxIdRow extends Schema.Class<MaxIdRow>("MaxIdRow")({
  max_id: Schema.NullOr(Schema.Number),
}) {}

const decodeRow = <A, I>(schema: Schema.Schema<A, I, never>, label: string) =>
  (row: unknown): Effect.Effect<A, PithosError> =>
    Schema.decodeUnknown(schema)(row).pipe(
      Effect.mapError(
        () =>
          new PE({
            code: "INTERNAL_ERROR",
            message: `${label} row shape violation`,
          }),
      ),
    )

export const decodeIdRow = decodeRow(IdRow, "id")
export const decodeMaxIdRow = decodeRow(MaxIdRow, "max-id")
export const decodeScopeRow = decodeRow(ScopeRow, "scope")
export const decodeRunRow = decodeRow(RunRow, "run")
export const decodeTaskRow = decodeRow(TaskRow, "task")
export const decodeArtifactRow = decodeRow(ArtifactRow, "artifact")
export const decodeEventRow = decodeRow(EventRow, "event")

export const loadRequiredScopeRow = (
  db: DbLike,
  scopeId: string,
): Effect.Effect<ScopeRow, PithosError> =>
  Effect.gen(function* () {
    const rows = yield* db.query(`SELECT * FROM scopes WHERE id = ?`, [scopeId])
    if (rows.length === 0) {
      yield* Effect.fail(new PE({ code: "NOT_FOUND", message: `Scope not found: ${scopeId}` }))
    }
    return yield* decodeScopeRow(rows[0]!)
  })

export const loadRequiredRunRow = (
  db: DbLike,
  runId: string,
): Effect.Effect<RunRow, PithosError> =>
  Effect.gen(function* () {
    const rows = yield* db.query(`SELECT * FROM runs WHERE id = ?`, [runId])
    if (rows.length === 0) {
      yield* Effect.fail(new PE({ code: "NOT_FOUND", message: `Run not found: ${runId}` }))
    }
    return yield* decodeRunRow(rows[0]!)
  })

export const loadRequiredTaskRow = (
  db: DbLike,
  taskId: string,
): Effect.Effect<TaskRow, PithosError> =>
  Effect.gen(function* () {
    const rows = yield* db.query(`SELECT * FROM tasks WHERE id = ?`, [taskId])
    if (rows.length === 0) {
      yield* Effect.fail(new PE({ code: "NOT_FOUND", message: `Task not found: ${taskId}` }))
    }
    return yield* decodeTaskRow(rows[0]!)
  })
