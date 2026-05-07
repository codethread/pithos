import { Effect, Schema } from "effect"
import { decodeEventRow } from "../db/helpers.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 1000

export interface TailOptions {
  readonly limit?: number | undefined
}

export const tailCommand = (
  opts: TailOptions = {},
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const rawLimit = opts.limit ?? DEFAULT_LIMIT
    const limit = yield* Schema.decodeUnknown(Schema.Int)(rawLimit).pipe(
      Effect.mapError(
        () =>
          new PithosError({
            code: "VALIDATION_ERROR",
            message: `--limit must be a positive integer, got: ${String(rawLimit)}`,
          }),
      ),
    )

    if (limit <= 0) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `--limit must be a positive integer, got: ${limit}`,
        }),
      )
    }
    if (limit > MAX_LIMIT) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `--limit exceeds maximum of ${MAX_LIMIT}, got: ${limit}`,
        }),
      )
    }

    const db = yield* DbService
    const output = yield* OutputService
    const rawRows = yield* db.query(
      `SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
      [limit],
    )
    const events = yield* Effect.forEach(rawRows, decodeEventRow)

    yield* output.print(JSON.stringify({ ok: true, count: events.length, events }))
  }).pipe(Effect.withLogSpan("pithos.events.tail"), withCommandObservability("events.tail"))
