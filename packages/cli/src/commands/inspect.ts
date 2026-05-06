import { Effect, Schema } from "effect"
import { ArtifactRow, TaskRow } from "../db/rows.ts"
import {
  computeTaskClaimability,
  loadDirectDependencies,
  loadDirectDependents,
  loadSupersededBySummary,
  loadSupersedesSummary,
  loadTaskGraph,
  loadUnresolvedDependencyIds,
} from "../domain/task-graph.ts"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"

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

const decodeArtifactRow = (row: unknown): Effect.Effect<ArtifactRow, PithosError> =>
  Schema.decodeUnknown(ArtifactRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "ArtifactRow shape violation from DB",
        }),
    ),
  )

const toInspectableTask = (
  task: TaskRow,
  claimable: boolean,
  unresolvedDependencyIds: readonly string[],
) => ({
  id: task.id,
  scope_id: task.scope_id,
  capability: task.capability,
  status: task.status,
  title: task.title,
  body: task.body,
  payload_json: task.payload_json,
  lease_owner_run_id: task.lease_owner_run_id,
  lease_until: task.lease_until,
  fencing_token: task.fencing_token,
  attempts: task.attempts,
  max_attempts: task.max_attempts,
  result_json: task.result_json,
  created_by_run_id: task.created_by_run_id,
  created_at: task.created_at,
  updated_at: task.updated_at,
  completed_at: task.completed_at,
  claimable,
  unresolved_dependency_ids: unresolvedDependencyIds,
})

/**
 * `pithos inspect scope <id>`
 *
 * Fetches the scope row and prints it as JSON.
 * Exits with code 3 (NOT_FOUND) if the scope does not exist.
 */
export const inspectScopeCommand = (
  id: string,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    const rows = yield* db.query(`SELECT * FROM scopes WHERE id = ?`, [id])

    if (rows.length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Scope not found: ${id}` }),
      )
      return
    }

    yield* output.print(JSON.stringify({ ok: true, scope: rows[0] }))
  }).pipe(
    Effect.withLogSpan("pithos.inspect.scope"),
    withCommandObservability("inspect.scope"),
  )

/**
 * `pithos inspect task <id>`
 *
 * Fetches the task, direct graph relationships, and artifacts, then prints
 * machine-readable JSON.
 */
export const inspectTaskCommand = (
  id: string,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    const rows = yield* db.query(`SELECT * FROM tasks WHERE id = ?`, [id])

    if (rows.length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Task not found: ${id}` }),
      )
      return
    }

    const task = yield* decodeTaskRow(rows[0]!)
    const dependencies = yield* loadDirectDependencies(id)
    const dependents = yield* loadDirectDependents(id)
    const unresolvedDependencyIds = yield* loadUnresolvedDependencyIds(id)
    const supersedes = yield* loadSupersedesSummary(id)
    const supersededBy = yield* loadSupersededBySummary(id)
    const claimability = computeTaskClaimability(task, unresolvedDependencyIds, supersededBy)

    const artifacts = yield* db.query(
      `SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC`,
      [id],
    ).pipe(
      Effect.flatMap((artifactRows) => Effect.forEach(artifactRows, decodeArtifactRow)),
    )

    yield* output.print(
      JSON.stringify({
        ok: true,
        task: toInspectableTask(task, claimability.claimable, claimability.unresolvedDependencyIds),
        dependencies,
        dependents,
        supersedes,
        superseded_by: supersededBy,
        artifacts,
      }),
    )
  }).pipe(
    Effect.withLogSpan("pithos.inspect.task"),
    withCommandObservability("inspect.task"),
  )

/**
 * `pithos inspect graph --task <id>`
 *
 * Returns a closed transitive dependency/supersession graph around a single task.
 */
export const inspectGraphCommand = (
  taskId: string,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const output = yield* OutputService
    const graph = yield* loadTaskGraph(taskId)

    yield* output.print(
      JSON.stringify({
        ok: true,
        graph: {
          selector: { kind: "task", value: taskId },
          nodes: graph.nodes,
          edges: graph.edges,
        },
      }),
    )
  }).pipe(
    Effect.withLogSpan("pithos.inspect.graph"),
    withCommandObservability("inspect.graph"),
  )

/**
 * `pithos inspect run <id>`
 *
 * Fetches the run row and prints it as JSON.
 * Exits with code 3 (NOT_FOUND) if the run does not exist.
 */
export const inspectRunCommand = (
  id: string,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    const rows = yield* db.query(`SELECT * FROM runs WHERE id = ?`, [id])

    if (rows.length === 0) {
      yield* Effect.fail(
        new PithosError({ code: "NOT_FOUND", message: `Run not found: ${id}` }),
      )
      return
    }

    yield* output.print(JSON.stringify({ ok: true, run: rows[0] }))
  }).pipe(
    Effect.withLogSpan("pithos.inspect.run"),
    withCommandObservability("inspect.run"),
  )

export const INSPECT_HELP = `pithos inspect - Inspect a pithos entity

Usage:
  pithos inspect scope <id>
  pithos inspect run <id>
  pithos inspect task <id>
  pithos inspect graph --task <id>

Options:
  --help, -h    Show this help

Subcommands:
  scope <id>          Show a scope by ID
  run <id>            Show a run by ID
  task <id>           Show a task by ID with direct dependencies, dependents, blockers, supersession links, and artifacts
  graph --task <id>   Show a closed transitive dependency/supersession graph around one task

Output (JSON):
  { "ok": true, "scope": { "id": "...", "kind": "...", ... } }
  { "ok": true, "run": { "id": "...", "agent_kind": "...", ... } }
  { "ok": true, "task": { "id": "...", "status": "queued", "claimable": false, "unresolved_dependency_ids": [ ... ], ... }, "dependencies": [ ... ], "dependents": [ ... ], "supersedes": null, "superseded_by": null, "artifacts": [ ... ] }
  { "ok": true, "graph": { "selector": { "kind": "task", "value": "task_..." }, "nodes": [ { "id": "...", "scope_id": "...", "capability": "...", "status": "...", "title": "...", "claimable": false, "unresolved_dependency_ids": [ ... ], "supersedes_task_id": null, "superseded_by_task_id": null } ], "edges": [ { "kind": "depends_on", "from_task_id": "...", "to_task_id": "...", "satisfied": true }, { "kind": "supersedes", "from_task_id": "...", "to_task_id": "..." } ] } }

Examples:
  pithos inspect scope global
  pithos inspect scope repo:work/perkbox-services/protobuf
  pithos inspect run run_abc123
  pithos inspect task task_abc123
  pithos inspect graph --task task_abc123

Exit codes: 0 success | 3 not found
`
