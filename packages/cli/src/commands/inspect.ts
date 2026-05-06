import { Effect, Schema } from "effect"
import { ArtifactRow, TaskRow } from "../db/rows.ts"
import {
  computeTaskClaimability,
  loadDirectDependencies,
  loadDirectDependents,
  loadLiveTaskGraph,
  loadScopeTaskGraph,
  loadSupersededBySummary,
  loadSupersedesSummary,
  loadTaskGraph,
  loadUnresolvedDependencies,
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
    const unresolvedBlockers = yield* loadUnresolvedDependencies(id)
    const unresolvedDependencyIds = unresolvedBlockers.map((b) => b.id)
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
        unresolved_blockers: unresolvedBlockers,
        supersedes,
        superseded_by: supersededBy,
        artifacts,
      }),
    )
  }).pipe(
    Effect.withLogSpan("pithos.inspect.task"),
    withCommandObservability("inspect.task"),
  )

export type InspectGraphSelector =
  | { readonly kind: "task"; readonly value: string }
  | { readonly kind: "scope"; readonly value: string }
  | { readonly kind: "live" }

export interface InspectGraphSelectorArgs {
  readonly taskId: string | undefined
  readonly scopeId: string | undefined
  readonly live: boolean
}

export const decodeInspectGraphSelector = (
  args: InspectGraphSelectorArgs,
): Effect.Effect<InspectGraphSelector, PithosError> =>
  Effect.gen(function* () {
    const selectedCount = [args.taskId !== undefined, args.scopeId !== undefined, args.live].filter(
      Boolean,
    ).length

    if (selectedCount !== 1) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "inspect graph requires exactly one selector: choose one of --task, --scope, or --live",
        }),
      )
      return yield* Effect.never
    }

    if (args.taskId !== undefined) {
      return { kind: "task", value: args.taskId } as const
    }
    if (args.scopeId !== undefined) {
      return { kind: "scope", value: args.scopeId } as const
    }
    return { kind: "live" } as const
  })

/**
 * `pithos inspect graph --task <id> | --scope <scope-id> | --live`
 *
 * Returns a closed transitive dependency/supersession graph for the selected seed set.
 */
export const inspectGraphCommand = (
  selector: InspectGraphSelector,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const output = yield* OutputService
    const graph =
      selector.kind === "task"
        ? yield* loadTaskGraph(selector.value)
        : selector.kind === "scope"
          ? yield* loadScopeTaskGraph(selector.value)
          : yield* loadLiveTaskGraph()

    yield* output.print(
      JSON.stringify({
        ok: true,
        graph: {
          selector,
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
  pithos inspect graph --scope <scope-id>
  pithos inspect graph --live

Options:
  --help, -h    Show this help

Subcommands:
  scope <id>             Show a scope by ID
  run <id>               Show a run by ID
  task <id>              Show a task by ID with direct dependencies, dependents, blockers, supersession links, and artifacts
  graph --task <id>      Show a closed transitive dependency/supersession graph around one task
  graph --scope <id>     Show a closed transitive dependency/supersession graph around a scope's non-cancelled tasks
  graph --live           Show the closed transitive dependency/supersession graph for all non-cancelled tasks

Output (JSON):
  { "ok": true, "scope": { "id": "...", "kind": "...", ... } }
  { "ok": true, "run": { "id": "...", "agent_kind": "...", ... } }
  { "ok": true, "task": { "id": "...", "status": "queued", "claimable": false, "unresolved_dependency_ids": [ ... ], ... }, "dependencies": [ ... ], "dependents": [ ... ], "unresolved_blockers": [ { "id": "...", "scope_id": "...", "status": "queued", "title": "Blocker title" } ], "supersedes": null, "superseded_by": null, "artifacts": [ ... ] }
  { "ok": true, "graph": { "selector": { "kind": "task", "value": "task_..." } | { "kind": "scope", "value": "repo:..." } | { "kind": "live" }, "nodes": [ { "id": "...", "scope_id": "...", "capability": "...", "status": "...", "title": "...", "claimable": false, "unresolved_dependency_ids": [ ... ], "supersedes_task_id": null, "superseded_by_task_id": null } ], "edges": [ { "kind": "depends_on", "from_task_id": "...", "to_task_id": "...", "satisfied": true }, { "kind": "supersedes", "from_task_id": "...", "to_task_id": "..." } ] } }

Examples:
  pithos inspect scope global
  pithos inspect scope repo:work/perkbox-services/protobuf
  pithos inspect run run_abc123
  pithos inspect task task_abc123
  pithos inspect graph --task task_abc123
  pithos inspect graph --scope repo:work/perkbox-services/protobuf
  pithos inspect graph --live

Exit codes: 0 success | 2 validation error | 3 not found
`
