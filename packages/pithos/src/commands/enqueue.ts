import { Effect, Schema } from "effect"
import { assertTaskGraphAcyclic } from "../domain/task-graph.ts"
import {
  assertCapabilityScopeAllowed,
  assertRunCanEnqueueCapability,
  decodeCapability,
} from "../domain/auth.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { FsService } from "../services/fs.ts"
import { IdService } from "../services/ids.ts"
import { OutputService } from "../services/output.ts"
import {
  decodeTaskRow,
  decodeIdRow,
  loadRequiredRunRow,
  loadRequiredScopeRow,
  loadRequiredTaskRow,
} from "../db/helpers.ts"

class SupersededDependencyRow extends Schema.Class<SupersededDependencyRow>(
  "SupersededDependencyRow",
)({
  old_task_id: Schema.String,
  new_task_id: Schema.String,
  scope_id: Schema.String,
  status: Schema.String,
  title: Schema.String,
}) {}

interface TaskCreatedEventPayload {
  readonly scope_id: string
  readonly capability: string
  readonly title: string
  readonly depends_on_task_ids: readonly string[]
}

const decodeSupersededDependencyRow = (row: unknown): Effect.Effect<SupersededDependencyRow, PithosError> =>
  Schema.decodeUnknown(SupersededDependencyRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "superseded dependency row shape violation",
        }),
    ),
  )

const resolveTaskBody = (
  inlineBody: string | undefined,
  bodyFile: string | undefined,
): Effect.Effect<string, PithosError, FsService> =>
  Effect.gen(function* () {
    if (inlineBody !== undefined && bodyFile !== undefined) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "--body and --body-file are mutually exclusive; supply exactly one",
        }),
      )
    }

    const fs = yield* FsService
    const body =
      bodyFile !== undefined ? yield* fs.readFile(bodyFile) : inlineBody ?? ""

    if (body.trim().length === 0) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "Task body must be non-empty; supply --body or --body-file",
        }),
      )
    }

    return body
  })

export interface EnqueueOptions {
  readonly scope: string | undefined
  readonly capability: string | undefined
  readonly title: string | undefined
  readonly body?: string | undefined
  readonly bodyFile?: string | undefined
  readonly dependsOn?: readonly string[] | undefined
  readonly run?: string | undefined
}

export const enqueueCommand = (
  opts: EnqueueOptions,
): Effect.Effect<void, PithosError, DbService | IdService | FsService | OutputService> =>
  Effect.gen(function* () {
    if (opts.scope === undefined) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--scope is required" }))
    }
    if (opts.title === undefined || opts.title.trim().length === 0) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--title is required" }))
    }
    if (opts.run === undefined) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }))
    }
    if (opts.capability === undefined) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--capability is required" }),
      )
    }

    const scopeId = opts.scope!
    const title = opts.title!.trim()
    const runId = opts.run!
    const capability = yield* decodeCapability(opts.capability!)
    const body = yield* resolveTaskBody(opts.body, opts.bodyFile)
    const dependsOnTaskIds = [...(opts.dependsOn ?? [])]

    const duplicateDependencyIds = [...new Set(
      dependsOnTaskIds.filter(
        (dependencyId, index) => dependsOnTaskIds.indexOf(dependencyId) !== index,
      ),
    )]
    if (duplicateDependencyIds.length > 0) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `Duplicate --depends-on task IDs: ${duplicateDependencyIds.join(", ")}`,
        }),
      )
    }

    const db = yield* DbService
    const ids = yield* IdService
    const output = yield* OutputService

    const scope = yield* loadRequiredScopeRow(db, scopeId)
    const run = yield* loadRequiredRunRow(db, runId)
    yield* assertCapabilityScopeAllowed(capability, scope)
    yield* Effect.provideService(assertRunCanEnqueueCapability(run, capability), DbService, db)

    const taskId = yield* ids.generate("task")

    yield* db.withTransaction(
      Effect.gen(function* () {
        yield* loadRequiredScopeRow(db, scopeId)
        const actorRun = yield* loadRequiredRunRow(db, runId)
        yield* Effect.provideService(assertRunCanEnqueueCapability(actorRun, capability), DbService, db)

        for (const dependencyId of dependsOnTaskIds) {
          yield* loadRequiredTaskRow(db, dependencyId)

          const supersededRows = yield* db.query(
            `SELECT ts.old_task_id, ts.new_task_id, t.scope_id, t.status, t.title
             FROM task_supersessions ts
             JOIN tasks t ON t.id = ts.new_task_id
             WHERE ts.old_task_id = ?`,
            [dependencyId],
          )
          if (supersededRows.length > 0) {
            const replacement = yield* decodeSupersededDependencyRow(supersededRows[0]!)
            yield* Effect.fail(
              new PithosError({
                code: "USER_ERROR",
                message:
                  `Dependency task ${replacement.old_task_id} has been superseded by ${replacement.new_task_id} ` +
                  `(scope ${replacement.scope_id}, status ${replacement.status}, title ${JSON.stringify(replacement.title)}). ` +
                  `Enqueue against the replacement task instead.`,
              }),
            )
          }
        }

        const insertedRows = yield* db.query(
          `INSERT INTO tasks
             (id, scope_id, capability, status, title, body, created_by_run_id)
           VALUES (?, ?, ?, 'queued', ?, ?, ?)
           RETURNING *`,
          [taskId, scopeId, capability, title, body, runId],
        )
        if (insertedRows.length === 0) {
          yield* Effect.fail(
            new PithosError({
              code: "INTERNAL_ERROR",
              message: `task insert returned no row for ${taskId}`,
            }),
          )
        }
        yield* decodeTaskRow(insertedRows[0]!)

        for (const dependencyId of dependsOnTaskIds) {
          const dependencyRows = yield* db.query(
            `INSERT INTO task_dependencies (task_id, depends_on_task_id)
             VALUES (?, ?)
             RETURNING task_id AS id`,
            [taskId, dependencyId],
          )
          if (dependencyRows.length !== 1) {
            yield* Effect.fail(
              new PithosError({
                code: "INTERNAL_ERROR",
                message: `dependency insert returned ${dependencyRows.length} rows for ${dependencyId}`,
              }),
            )
          }
          yield* decodeIdRow(dependencyRows[0]!)
        }

        yield* Effect.provideService(assertTaskGraphAcyclic, DbService, db)

        const taskCreatedEventPayload = {
          scope_id: scopeId,
          capability,
          title,
          depends_on_task_ids: dependsOnTaskIds,
        } satisfies TaskCreatedEventPayload

        yield* db.run(
          `INSERT INTO events (task_id, actor_run_id, type, payload_json)
           VALUES (?, ?, 'task.created', ?)`,
          [taskId, runId, JSON.stringify(taskCreatedEventPayload)],
        )
      }),
    )

    const rows = yield* db.query(`SELECT * FROM tasks WHERE id = ?`, [taskId])
    const task = yield* decodeTaskRow(rows[0]!)
    yield* output.print(JSON.stringify({ ok: true, task }))
  }).pipe(Effect.withLogSpan("pithos.task.enqueue"), withCommandObservability("task.enqueue"))
