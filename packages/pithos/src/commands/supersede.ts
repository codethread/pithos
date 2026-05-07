import { Effect, Schema } from "effect"
import { decodeIdRow, decodeTaskRow, loadRequiredRunRow, loadRequiredScopeRow, loadRequiredTaskRow } from "../db/helpers.ts"
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

class TaskSupersessionTargetRow extends Schema.Class<TaskSupersessionTargetRow>(
  "TaskSupersessionTargetRow",
)({
  new_task_id: Schema.String,
}) {}

class DirectDependentStatusRow extends Schema.Class<DirectDependentStatusRow>(
  "DirectDependentStatusRow",
)({
  id: Schema.String,
  status: Schema.String,
  created_at: Schema.String,
}) {}

class DirectDependencyIdRow extends Schema.Class<DirectDependencyIdRow>("DirectDependencyIdRow")({
  depends_on_task_id: Schema.String,
}) {}

interface TaskCreatedEventPayload {
  readonly scope_id: string
  readonly capability: string
  readonly title: string
  readonly depends_on_task_ids: readonly string[]
  readonly supersedes_task_id: string
}

interface TaskCancelledEventPayload {
  readonly reason: string
  readonly superseded_by_task_id: string
}

interface TaskSupersededEventPayload {
  readonly new_task_id: string
  readonly reason: string
  readonly retargeted_dependent_task_ids: readonly string[]
}

const decodeTaskSupersessionTargetRow = (
  row: unknown,
): Effect.Effect<TaskSupersessionTargetRow, PithosError> =>
  Schema.decodeUnknown(TaskSupersessionTargetRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "task supersession row shape violation",
        }),
    ),
  )

const decodeDirectDependentStatusRow = (
  row: unknown,
): Effect.Effect<DirectDependentStatusRow, PithosError> =>
  Schema.decodeUnknown(DirectDependentStatusRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "direct dependent row shape violation",
        }),
    ),
  )

const decodeDirectDependencyIdRow = (
  row: unknown,
): Effect.Effect<DirectDependencyIdRow, PithosError> =>
  Schema.decodeUnknown(DirectDependencyIdRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "direct dependency row shape violation",
        }),
    ),
  )

export interface SupersedeOptions {
  readonly taskId: string | undefined
  readonly run: string | undefined
  readonly reason: string | undefined
  readonly title?: string | undefined
  readonly body?: string | undefined
  readonly bodyFile?: string | undefined
  readonly scope?: string | undefined
  readonly capability?: string | undefined
}

export const supersedeCommand = (
  opts: SupersedeOptions,
): Effect.Effect<void, PithosError, DbService | IdService | FsService | OutputService> =>
  Effect.gen(function* () {
    if (!opts.taskId) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "task id argument is required" }),
      )
    }
    if (!opts.run) {
      yield* Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }))
    }
    if (opts.reason === undefined || opts.reason.trim().length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--reason is required" }),
      )
    }
    if (opts.body !== undefined && opts.bodyFile !== undefined) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "--body and --body-file are mutually exclusive; supply one or neither",
        }),
      )
    }

    const taskId = opts.taskId!
    const runId = opts.run!
    const reason = opts.reason!.trim()

    const fs = yield* FsService
    const ids = yield* IdService
    const db = yield* DbService
    const output = yield* OutputService

    let bodyOverride = opts.body
    if (opts.bodyFile !== undefined) {
      bodyOverride = yield* fs.readFile(opts.bodyFile)
    }

    const replacementTaskId = yield* ids.generate("task")

    const txResult = yield* db.withTransaction(
      Effect.gen(function* () {
        const oldTask = yield* loadRequiredTaskRow(db, taskId)
        const actorRun = yield* loadRequiredRunRow(db, runId)

        switch (oldTask.status) {
          case "queued":
          case "failed":
          case "dead_letter":
          case "cancelled":
            break
          case "claimed":
          case "running":
            yield* Effect.fail(
              new PithosError({
                code: "USER_ERROR",
                message: `Cannot supersede task ${taskId} while it is ${oldTask.status}`,
              }),
            )
            break
          case "done":
            yield* Effect.fail(
              new PithosError({
                code: "USER_ERROR",
                message: `Cannot supersede task ${taskId} because it is done`,
              }),
            )
            break
        }

        const supersessionRows = yield* db.query(
          `SELECT new_task_id FROM task_supersessions WHERE old_task_id = ?`,
          [taskId],
        )
        if (supersessionRows.length > 0) {
          const supersession = yield* decodeTaskSupersessionTargetRow(supersessionRows[0]!)
          yield* Effect.fail(
            new PithosError({
              code: "USER_ERROR",
              message: `Task ${taskId} has already been superseded by ${supersession.new_task_id}`,
            }),
          )
        }

        const replacementScopeId = opts.scope ?? oldTask.scope_id
        const replacementScope = yield* loadRequiredScopeRow(db, replacementScopeId)
        const replacementCapability =
          opts.capability === undefined ? oldTask.capability : yield* decodeCapability(opts.capability)
        const replacementTitle = (opts.title ?? oldTask.title).trim()
        const replacementBody = (bodyOverride ?? oldTask.body).trim()

        if (replacementTitle.length === 0) {
          yield* Effect.fail(
            new PithosError({ code: "VALIDATION_ERROR", message: "Replacement title must be non-empty" }),
          )
        }
        if (replacementBody.length === 0) {
          yield* Effect.fail(
            new PithosError({ code: "VALIDATION_ERROR", message: "Replacement body must be non-empty" }),
          )
        }

        yield* assertCapabilityScopeAllowed(replacementCapability, replacementScope)
        yield* Effect.provideService(
          assertRunCanEnqueueCapability(actorRun, replacementCapability),
          DbService,
          db,
        )

        const dependentRows = yield* db.query(
          `SELECT t.id, t.status, t.created_at
           FROM task_dependencies td
           JOIN tasks t ON t.id = td.task_id
           WHERE td.depends_on_task_id = ?
           ORDER BY t.created_at ASC, t.id ASC`,
          [taskId],
        )
        const directDependents = yield* Effect.forEach(dependentRows, decodeDirectDependentStatusRow)

        const invalidDependents = directDependents.filter(
          (dependent) => dependent.status !== "queued" && dependent.status !== "cancelled",
        )
        if (invalidDependents.length > 0) {
          yield* Effect.fail(
            new PithosError({
              code: "USER_ERROR",
              message:
                `Cannot supersede task ${taskId} because direct dependents have already left queued: ` +
                invalidDependents.map((dependent) => `${dependent.id} (${dependent.status})`).join(", "),
            }),
          )
        }

        const retargetedDependentTaskIds = directDependents
          .filter((dependent) => dependent.status === "queued")
          .map((dependent) => dependent.id)

        if (opts.scope !== undefined && opts.scope !== oldTask.scope_id && retargetedDependentTaskIds.length > 0) {
          yield* Effect.fail(
            new PithosError({
              code: "USER_ERROR",
              message:
                `Cannot change scope while superseding ${taskId}; queued direct dependents would be retargeted across scopes: ` +
                retargetedDependentTaskIds.join(", "),
            }),
          )
        }

        const dependencyRows = yield* db.query(
          `SELECT td.depends_on_task_id
           FROM task_dependencies td
           JOIN tasks t ON t.id = td.depends_on_task_id
           WHERE td.task_id = ?
           ORDER BY t.created_at ASC, t.id ASC`,
          [taskId],
        )
        const dependencyIds = yield* Effect.forEach(dependencyRows, decodeDirectDependencyIdRow).pipe(
          Effect.map((rows) => rows.map((row) => row.depends_on_task_id)),
        )

        const replacementRows = yield* db.query(
          `INSERT INTO tasks
             (id, scope_id, capability, status, title, body, payload_json, fencing_token, attempts, max_attempts, result_json, created_by_run_id, completed_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, 0, ?, '{}', ?, NULL)
           RETURNING *`,
          [
            replacementTaskId,
            replacementScopeId,
            replacementCapability,
            replacementTitle,
            replacementBody,
            oldTask.payload_json,
            oldTask.max_attempts,
            runId,
          ],
        )
        if (replacementRows.length !== 1) {
          yield* Effect.fail(
            new PithosError({
              code: "INTERNAL_ERROR",
              message: `replacement task insert returned ${replacementRows.length} rows`,
            }),
          )
        }
        const replacementTask = yield* decodeTaskRow(replacementRows[0]!)

        for (const dependencyId of dependencyIds) {
          const insertedRows = yield* db.query(
            `INSERT INTO task_dependencies (task_id, depends_on_task_id)
             VALUES (?, ?)
             RETURNING task_id AS id`,
            [replacementTaskId, dependencyId],
          )
          if (insertedRows.length !== 1) {
            yield* Effect.fail(
              new PithosError({
                code: "INTERNAL_ERROR",
                message: `dependency copy returned ${insertedRows.length} rows for ${dependencyId}`,
              }),
            )
          }
          yield* decodeIdRow(insertedRows[0]!)
        }

        for (const dependentTaskId of retargetedDependentTaskIds) {
          const rewiredRows = yield* db.query(
            `UPDATE task_dependencies
             SET depends_on_task_id = ?
             WHERE task_id = ?
               AND depends_on_task_id = ?
               AND EXISTS (
                 SELECT 1
                 FROM tasks t
                 WHERE t.id = task_dependencies.task_id
                   AND t.status = 'queued'
               )
             RETURNING task_id AS id`,
            [replacementTaskId, dependentTaskId, taskId],
          )
          if (rewiredRows.length !== 1) {
            yield* Effect.fail(
              new PithosError({
                code: "INTERNAL_ERROR",
                message: `Direct dependent rewire affected ${rewiredRows.length} rows for task ${dependentTaskId}`,
              }),
            )
          }
          yield* decodeIdRow(rewiredRows[0]!)
        }

        yield* db.run(
          `INSERT INTO task_supersessions (old_task_id, new_task_id, created_by_run_id, reason)
           VALUES (?, ?, ?, ?)`,
          [taskId, replacementTaskId, runId, reason],
        )

        if (oldTask.status === "queued") {
          const cancelledRows = yield* db.query(
            `UPDATE tasks
             SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
               AND status = 'queued'
             RETURNING id`,
            [taskId],
          )
          if (cancelledRows.length !== 1) {
            yield* Effect.fail(
              new PithosError({
                code: "INTERNAL_ERROR",
                message: `Queued task cancellation affected ${cancelledRows.length} rows for task ${taskId}`,
              }),
            )
          }
          yield* decodeIdRow(cancelledRows[0]!)

          const taskCancelledEventPayload = {
            reason,
            superseded_by_task_id: replacementTaskId,
          } satisfies TaskCancelledEventPayload

          yield* db.run(
            `INSERT INTO events (task_id, actor_run_id, type, payload_json)
             VALUES (?, ?, 'task.cancelled', ?)`,
            [taskId, runId, JSON.stringify(taskCancelledEventPayload)],
          )
        }

        const taskCreatedEventPayload = {
          scope_id: replacementScopeId,
          capability: replacementCapability,
          title: replacementTitle,
          depends_on_task_ids: dependencyIds,
          supersedes_task_id: taskId,
        } satisfies TaskCreatedEventPayload

        yield* db.run(
          `INSERT INTO events (task_id, actor_run_id, type, payload_json)
           VALUES (?, ?, 'task.created', ?)`,
          [replacementTaskId, runId, JSON.stringify(taskCreatedEventPayload)],
        )

        const taskSupersededEventPayload = {
          new_task_id: replacementTaskId,
          reason,
          retargeted_dependent_task_ids: retargetedDependentTaskIds,
        } satisfies TaskSupersededEventPayload

        yield* db.run(
          `INSERT INTO events (task_id, actor_run_id, type, payload_json)
           VALUES (?, ?, 'task.superseded', ?)`,
          [taskId, runId, JSON.stringify(taskSupersededEventPayload)],
        )

        yield* Effect.provideService(assertTaskGraphAcyclic, DbService, db)

        return {
          task: replacementTask,
          retargetedDependentTaskIds,
        }
      }),
    )

    yield* output.print(
      JSON.stringify({
        ok: true,
        task: {
          id: txResult.task.id,
          status: txResult.task.status,
          scope_id: txResult.task.scope_id,
          capability: txResult.task.capability,
        },
        supersession: {
          old_task_id: taskId,
          new_task_id: txResult.task.id,
          retargeted_dependent_task_ids: txResult.retargetedDependentTaskIds,
        },
      }),
    )
  }).pipe(Effect.withLogSpan("pithos.task.supersede"), withCommandObservability("task.supersede"))
