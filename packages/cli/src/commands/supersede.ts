import { Effect, Schema } from "effect"
import { TaskRow } from "../db/rows.ts"
import { assertTaskGraphAcyclic } from "../domain/task-graph.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { FsService } from "../services/fs.ts"
import { IdService } from "../services/ids.ts"
import { OutputService } from "../services/output.ts"

class IdRow extends Schema.Class<IdRow>("IdRow")({
  id: Schema.String,
}) {}

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

class DirectDependencyIdRow extends Schema.Class<DirectDependencyIdRow>(
  "DirectDependencyIdRow",
)({
  depends_on_task_id: Schema.String,
}) {}

interface TaskCreatedEventPayload {
  readonly scope_id: string
  readonly capability: string
  readonly title: string
  readonly depends_on_task_ids: readonly string[]
  readonly supersedes_task_id?: string
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

const decodeTaskRow = (row: unknown): Effect.Effect<TaskRow, PithosError> =>
  Schema.decodeUnknown(TaskRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "TaskRow shape violation from DB",
        }),
    ),
  )

const decodeIdRow = (row: unknown): Effect.Effect<IdRow, PithosError> =>
  Schema.decodeUnknown(IdRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "id row shape violation",
        }),
    ),
  )

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

interface SupersedeResult {
  readonly task: TaskRow
  readonly retargetedDependentTaskIds: readonly string[]
}

export const supersedeCommand = (
  opts: SupersedeOptions,
): Effect.Effect<void, PithosError, DbService | IdService | FsService | OutputService> =>
  Effect.gen(function* () {
    if (!opts.taskId) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "task id argument is required" }),
      )
      return
    }
    if (!opts.run) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }),
      )
      return
    }
    if (opts.reason === undefined) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--reason is required" }),
      )
      return
    }
    if (opts.body !== undefined && opts.bodyFile !== undefined) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "--body and --body-file are mutually exclusive; supply one or neither",
        }),
      )
      return
    }

    const taskId = opts.taskId
    const runId = opts.run
    const reason = opts.reason.trim()

    if (reason.length === 0) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "--reason must be non-empty",
        }),
      )
      return
    }

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
        const taskRows = yield* db.query(`SELECT * FROM tasks WHERE id = ?`, [taskId])
        if (taskRows.length === 0) {
          yield* Effect.fail(
            new PithosError({ code: "NOT_FOUND", message: `Task not found: ${taskId}` }),
          )
          return yield* Effect.never
        }
        const oldTask = yield* decodeTaskRow(taskRows[0]!)

        const runRows = yield* db.query(`SELECT id FROM runs WHERE id = ?`, [runId])
        if (runRows.length === 0) {
          yield* Effect.fail(
            new PithosError({ code: "NOT_FOUND", message: `Run not found: ${runId}` }),
          )
          return yield* Effect.never
        }
        yield* decodeIdRow(runRows[0]!)

        if (oldTask.status === "claimed" || oldTask.status === "running") {
          yield* Effect.fail(
            new PithosError({
              code: "USER_ERROR",
              message: `Cannot supersede task ${taskId} while it is ${oldTask.status}`,
            }),
          )
          return yield* Effect.never
        }

        const supersessionRows = yield* db.query(
          `SELECT new_task_id
           FROM task_supersessions
           WHERE old_task_id = ?`,
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
          return yield* Effect.never
        }

        const replacementScopeId = opts.scope ?? oldTask.scope_id
        if (opts.scope !== undefined) {
          const scopeRows = yield* db.query(`SELECT id FROM scopes WHERE id = ?`, [replacementScopeId])
          if (scopeRows.length === 0) {
            yield* Effect.fail(
              new PithosError({
                code: "NOT_FOUND",
                message: `Scope not found: ${replacementScopeId}`,
              }),
            )
            return yield* Effect.never
          }
          yield* decodeIdRow(scopeRows[0]!)
        }

        const dependentRows = yield* db.query(
          `SELECT t.id, t.status, t.created_at
           FROM task_dependencies td
           JOIN tasks t ON t.id = td.task_id
           WHERE td.depends_on_task_id = ?
           ORDER BY t.created_at ASC, t.id ASC`,
          [taskId],
        )
        const directDependents = yield* Effect.forEach(
          dependentRows,
          decodeDirectDependentStatusRow,
        )

        const invalidDependents = directDependents.filter(
          (dependent) => dependent.status !== "queued" && dependent.status !== "cancelled",
        )
        if (invalidDependents.length > 0) {
          yield* Effect.fail(
            new PithosError({
              code: "USER_ERROR",
              message:
                `Cannot supersede task ${taskId} because direct dependents have already left queued: ` +
                invalidDependents
                  .map((dependent) => `${dependent.id} (${dependent.status})`)
                  .join(", "),
            }),
          )
          return yield* Effect.never
        }

        const retargetedDependentTaskIds = directDependents
          .filter((dependent) => dependent.status === "queued")
          .map((dependent) => dependent.id)

        const dependencyRows = yield* db.query(
          `SELECT td.depends_on_task_id
           FROM task_dependencies td
           JOIN tasks t ON t.id = td.depends_on_task_id
           WHERE td.task_id = ?
           ORDER BY t.created_at ASC, t.id ASC`,
          [taskId],
        )
        const dependencyIds = yield* Effect.forEach(
          dependencyRows,
          decodeDirectDependencyIdRow,
        ).pipe(
          Effect.map((rows) => rows.map((row) => row.depends_on_task_id)),
        )

        const replacementCapability = opts.capability ?? oldTask.capability
        const replacementTitle = opts.title ?? oldTask.title
        const replacementBody = bodyOverride ?? oldTask.body

        const replacementRows = yield* db.query(
          `INSERT INTO tasks
             (id, scope_id, capability, status, title, body, payload_json, lease_owner_run_id, lease_until, fencing_token, attempts, max_attempts, result_json, created_by_run_id, completed_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, NULL, NULL, 0, 0, ?, '{}', ?, NULL)
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
        if (replacementRows.length === 0) {
          yield* Effect.fail(
            new PithosError({
              code: "INTERNAL_ERROR",
              message: "replacement task insert returned no rows",
            }),
          )
          return yield* Effect.never
        }
        const replacementTask = yield* decodeTaskRow(replacementRows[0]!)

        for (const dependencyId of dependencyIds) {
          yield* db.run(
            `INSERT INTO task_dependencies (task_id, depends_on_task_id)
             VALUES (?, ?)`,
            [replacementTaskId, dependencyId],
          )
        }

        // Remove the old task's direct upstream dependency rows so the current-state
        // graph no longer includes obsolete old->blocker edges.
        // Supersession history is preserved via task_supersessions and events.
        yield* db.run(
          `DELETE FROM task_dependencies WHERE task_id = ?`,
          [taskId],
        )

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
            return yield* Effect.never
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
             SET status = 'cancelled', updated_at = datetime('now')
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
            return yield* Effect.never
          }
          yield* decodeIdRow(cancelledRows[0]!)
        }

        if (oldTask.status === "queued") {
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
        } satisfies SupersedeResult
      }),
    )

    yield* Effect.logDebug("task superseded").pipe(
      Effect.annotateLogs({
        oldTaskId: taskId,
        newTaskId: txResult.task.id,
        runId,
        retargetedDependentCount: String(txResult.retargetedDependentTaskIds.length),
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
  }).pipe(
    Effect.withLogSpan("pithos.supersede"),
    withCommandObservability("supersede"),
  )

export const SUPERSEDE_HELP = `pithos supersede - Replace a task with a fresh queued task

Usage:
  pithos supersede <task-id> --run <run-id> --reason <text> [options]

Arguments:
  <task-id>               Task ID to replace [required]

Options:
  --run <run-id>          Run ID performing the replacement [required]
  --reason <text>         Human-readable reason recorded with the supersession [required]
  --title <title>         Replacement task title (defaults to old task title)
  --body <text>           Replacement task body (mutually exclusive with --body-file)
  --body-file <path>      Replacement task body from file (mutually exclusive with --body)
  --scope <scope-id>      Replacement task scope (defaults to old task scope)
  --capability <cap>      Replacement task capability (defaults to old task capability)
  --help, -h              Show this help

Output (JSON):
  {
    "ok": true,
    "task": {
      "id": "task_...",
      "status": "queued",
      "scope_id": "repo:...",
      "capability": "build"
    },
    "supersession": {
      "old_task_id": "task_old",
      "new_task_id": "task_new",
      "retargeted_dependent_task_ids": ["task_child"]
    }
  }

Notes:
  - Rejects claimed/running tasks and tasks that were already superseded.
  - Copies the old task's direct upstream dependency edges to the replacement.
  - Retargets only direct queued dependents; cancelled dependents are ignored.
  - Any other direct dependent status fails the transaction loudly.

Examples:
  pithos supersede task_api --run run_pandora --reason "Wrong interface; replacing with corrected task"
  pithos supersede task_api --run run_pandora --reason "Need a repo-local replacement" --scope repo:work/repo --capability build --title "Fix API contract"

Exit codes: 0 success | 1 user error | 2 validation error | 3 not found
`
