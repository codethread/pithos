import { Effect } from "effect"
import { decodeArtifactRow, loadRequiredRunRow, loadRequiredTaskRow } from "../db/helpers.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { FsService } from "../services/fs.ts"
import { IdService } from "../services/ids.ts"
import { OutputService } from "../services/output.ts"

export interface ArtifactAddOptions {
  readonly task: string | undefined
  readonly run: string | undefined
  readonly kind: string | undefined
  readonly title: string | undefined
  readonly bodyFile: string | undefined
}

export const artifactAddCommand = (
  opts: ArtifactAddOptions,
): Effect.Effect<void, PithosError, DbService | IdService | FsService | OutputService> =>
  Effect.gen(function* () {
    if (!opts.task) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--task is required" }))
    }
    if (!opts.run) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }))
    }
    if (!opts.kind) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--kind is required" }))
    }
    if (!opts.title) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--title is required" }))
    }

    const taskId = opts.task!
    const runId = opts.run!
    const kind = opts.kind!
    const title = opts.title!

    const db = yield* DbService
    const ids = yield* IdService
    const fs = yield* FsService
    const output = yield* OutputService

    yield* loadRequiredTaskRow(db, taskId)
    yield* loadRequiredRunRow(db, runId)

    const body = opts.bodyFile === undefined ? "" : yield* fs.readFile(opts.bodyFile)
    const artifactId = yield* ids.generate("artifact")
    const rows = yield* db.query(
      `INSERT INTO artifacts (id, task_id, run_id, kind, title, body)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [artifactId, taskId, runId, kind, title, body],
    )

    if (rows.length !== 1) {
      yield* Effect.fail(
        new PithosError({
          code: "INTERNAL_ERROR",
          message: `artifact insert returned ${rows.length} rows for ${artifactId}`,
        }),
      )
    }

    const artifact = yield* decodeArtifactRow(rows[0]!)
    yield* output.print(JSON.stringify({ ok: true, artifact }))
  }).pipe(
    Effect.withLogSpan("pithos.task.artifact.add"),
    withCommandObservability("task.artifact.add"),
  )
