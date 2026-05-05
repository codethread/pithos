import { Effect, Schema } from "effect"
import { DbService } from "../services/db.ts"
import { IdService } from "../services/ids.ts"
import { FsService } from "../services/fs.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { assertTaskGraphAcyclic } from "../domain/task-graph.ts"

class TaskIdRow extends Schema.Class<TaskIdRow>("TaskIdRow")({
  id: Schema.String,
}) {}

class SupersededDependencyRow extends Schema.Class<SupersededDependencyRow>(
  "SupersededDependencyRow",
)({
  old_task_id: Schema.String,
  new_task_id: Schema.String,
  scope_id: Schema.String,
  status: Schema.String,
  title: Schema.String,
}) {}

const decodeTaskIdRow = (row: unknown): Effect.Effect<TaskIdRow, PithosError> =>
  Schema.decodeUnknown(TaskIdRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "task id row shape violation",
        }),
    ),
  )

const decodeSupersededDependencyRow = (
  row: unknown,
): Effect.Effect<SupersededDependencyRow, PithosError> =>
  Schema.decodeUnknown(SupersededDependencyRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "superseded dependency row shape violation",
        }),
    ),
  )

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  readonly scope: string | undefined
  readonly capability: string | undefined
  readonly title: string | undefined
  readonly body?: string | undefined
  readonly bodyFile?: string | undefined
  readonly dependsOn?: readonly string[] | undefined
  /** Run ID recorded as the task creator. */
  readonly run?: string | undefined
}

// ---------------------------------------------------------------------------
// pithos enqueue
// ---------------------------------------------------------------------------

/**
 * `pithos enqueue --scope <id> --capability <cap> --title <title> [options]`
 *
 * Creates a queued task, records dependency edges, and appends a
 * `task.created` event atomically.
 */
export const enqueueCommand = (
  opts: EnqueueOptions,
): Effect.Effect<void, PithosError, DbService | IdService | FsService | OutputService> =>
  Effect.gen(function* () {
    if (!opts.scope) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--scope is required" }),
      )
      return
    }
    if (!opts.capability) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--capability is required" }),
      )
      return
    }
    if (!opts.title) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--title is required" }),
      )
      return
    }

    const scope = opts.scope
    const capability = opts.capability
    const title = opts.title
    const dependsOnTaskIds = opts.dependsOn ?? []

    const seenDependencyIds = new Set<string>()
    const duplicateDependencyIds: string[] = []
    for (const dependencyId of dependsOnTaskIds) {
      if (seenDependencyIds.has(dependencyId) && !duplicateDependencyIds.includes(dependencyId)) {
        duplicateDependencyIds.push(dependencyId)
      }
      seenDependencyIds.add(dependencyId)
    }
    if (duplicateDependencyIds.length > 0) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `Duplicate --depends-on task IDs: ${duplicateDependencyIds.join(", ")}`,
        }),
      )
      return
    }

    const db = yield* DbService
    const ids = yield* IdService
    const fs = yield* FsService
    const output = yield* OutputService

    if (opts.body !== undefined && opts.bodyFile !== undefined) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "--body and --body-file are mutually exclusive; supply one or neither",
        }),
      )
      return
    }
    let body = opts.body ?? ""
    if (opts.bodyFile) {
      body = yield* fs.readFile(opts.bodyFile)
    }

    const scopeRows = yield* db.query(`SELECT id FROM scopes WHERE id = ?`, [scope])
    if (scopeRows.length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Scope not found: ${scope}` }),
      )
      return
    }

    if (opts.run) {
      const runRows = yield* db.query(`SELECT id FROM runs WHERE id = ?`, [opts.run])
      if (runRows.length === 0) {
        yield* Effect.fail(
          new PithosError({ code: "NOT_FOUND", message: `Run not found: ${opts.run}` }),
        )
        return
      }
    }

    for (const dependencyId of dependsOnTaskIds) {
      const dependencyRows = yield* db.query(`SELECT id FROM tasks WHERE id = ?`, [dependencyId])
      if (dependencyRows.length === 0) {
        yield* Effect.fail(
          new PithosError({
            code: "NOT_FOUND",
            message: `Dependency task not found: ${dependencyId}`,
          }),
        )
        return
      }
      yield* decodeTaskIdRow(dependencyRows[0]!)

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
        return
      }
    }

    const id = yield* ids.generate("task")

    yield* db.withTransaction(
      Effect.gen(function* () {
        yield* db.run(
          `INSERT INTO tasks
             (id, scope_id, capability, status, title, body, created_by_run_id)
           VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
          [id, scope, capability, title, body, opts.run ?? null],
        )

        for (const dependencyId of dependsOnTaskIds) {
          yield* db.run(
            `INSERT INTO task_dependencies (task_id, depends_on_task_id)
             VALUES (?, ?)`,
            [id, dependencyId],
          )
        }

        yield* Effect.provideService(assertTaskGraphAcyclic, DbService, db)

        yield* db.run(
          `INSERT INTO events (task_id, actor_run_id, type, payload_json)
           VALUES (?, ?, 'task.created', ?)`,
          [
            id,
            opts.run ?? null,
            JSON.stringify({
              scope_id: scope,
              capability,
              title,
              depends_on_task_ids: dependsOnTaskIds,
            }),
          ],
        )
      }),
    )

    const rows = yield* db.query(`SELECT * FROM tasks WHERE id = ?`, [id])

    yield* output.print(JSON.stringify({ ok: true, task: rows[0] }))
  }).pipe(
    Effect.withLogSpan("pithos.enqueue"),
    withCommandObservability("enqueue"),
  )

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const ENQUEUE_HELP = `pithos enqueue - Create a queued task

Usage:
  pithos enqueue --scope <scope-id> --capability <cap> --title <title> [options]

Options:
  --scope <scope-id>       Scope ID for this task [required]
  --capability <cap>       Task capability, e.g. watch, triage [required]
  --title <title>          Human-readable task title [required]
  --body-file <path>       File path for task body/description (mutually exclusive with --body)
  --body <text>            Inline task body (mutually exclusive with --body-file)
  --run <run-id>           Run ID to record as the task creator
  --depends-on <task-id>   Direct dependency target; repeatable and cross-scope
  --help, -h               Show this help

Output (JSON):
  { "ok": true, "task": { "id": "task_...", "scope_id": "...", "status": "queued", ... } }

Examples:
  pithos enqueue --scope global --capability triage --title "Review PR #42"
  pithos enqueue --scope repo:work/perkbox-services/protobuf --capability watch --title "Watch worker" --depends-on task_api --depends-on task_design

Exit codes: 0 success | 1 user error | 2 validation error | 3 not found
`
