import { Effect, Schema } from "effect"
import { TaskDependencyRow } from "../db/rows.ts"
import type { TaskRow } from "../db/rows.ts"
import { PithosError } from "../errors/errors.ts"
import { DbService } from "../services/db.ts"

export interface DependencyEdge {
  readonly taskId: string
  readonly dependsOnTaskId: string
}

export interface TaskRelationshipSummary {
  readonly id: string
  readonly scope_id: string
  readonly status: string
  readonly title: string
}

export interface TaskClaimability {
  readonly claimable: boolean
  readonly unresolvedDependencyIds: readonly string[]
}

class TaskRelationshipSummaryRow extends Schema.Class<TaskRelationshipSummaryRow>(
  "TaskRelationshipSummaryRow",
)({
  id: Schema.String,
  scope_id: Schema.String,
  status: Schema.String,
  title: Schema.String,
  created_at: Schema.String,
}) {}

class TaskIdRow extends Schema.Class<TaskIdRow>("TaskIdRow")({
  id: Schema.String,
  created_at: Schema.String,
}) {}

const decodeTaskDependencyRow = (row: unknown): Effect.Effect<TaskDependencyRow, PithosError> =>
  Schema.decodeUnknown(TaskDependencyRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "task_dependencies row shape violation",
        }),
    ),
  )

const decodeTaskRelationshipSummaryRow = (
  row: unknown,
): Effect.Effect<TaskRelationshipSummaryRow, PithosError> =>
  Schema.decodeUnknown(TaskRelationshipSummaryRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "task relationship row shape violation",
        }),
    ),
  )

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

export const findDependencyCycle = (
  edges: readonly DependencyEdge[],
): readonly string[] | null => {
  const nodes = new Set<string>()
  const adjacency = new Map<string, string[]>()

  for (const edge of edges) {
    nodes.add(edge.taskId)
    nodes.add(edge.dependsOnTaskId)
    const neighbors = adjacency.get(edge.taskId) ?? []
    neighbors.push(edge.dependsOnTaskId)
    adjacency.set(edge.taskId, neighbors)
  }

  const orderedAdjacency = new Map(
    [...adjacency.entries()].map(([node, neighbors]) => [
      node,
      [...neighbors].sort((left, right) => left.localeCompare(right)),
    ]),
  )

  const orderedNodes = [...nodes].sort((left, right) => left.localeCompare(right))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const visit = (node: string): readonly string[] | null => {
    visiting.add(node)
    stack.push(node)

    for (const neighbor of orderedAdjacency.get(node) ?? []) {
      if (visiting.has(neighbor)) {
        const cycleStart = stack.indexOf(neighbor)
        return [...stack.slice(cycleStart), neighbor]
      }
      if (!visited.has(neighbor)) {
        const cycle = visit(neighbor)
        if (cycle !== null) {
          return cycle
        }
      }
    }

    stack.pop()
    visiting.delete(node)
    visited.add(node)
    return null
  }

  for (const node of orderedNodes) {
    if (visited.has(node)) {
      continue
    }
    const cycle = visit(node)
    if (cycle !== null) {
      return cycle
    }
  }

  return null
}

export const assertTaskGraphAcyclic: Effect.Effect<void, PithosError, DbService> = Effect.gen(
  function* () {
    const db = yield* DbService
    const rows = yield* db.query(
      `SELECT task_id, depends_on_task_id, created_at
       FROM task_dependencies
       ORDER BY task_id ASC, depends_on_task_id ASC`,
    )
    const edges = yield* Effect.forEach(rows, decodeTaskDependencyRow).pipe(
      Effect.map((decodedRows) =>
        decodedRows.map((row) => ({
          taskId: row.task_id,
          dependsOnTaskId: row.depends_on_task_id,
        })),
      ),
    )

    const cycle = findDependencyCycle(edges)
    if (cycle !== null) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `dependency graph cycle detected: ${cycle.join(" -> ")}`,
        }),
      )
      return
    }
  },
)

const toTaskRelationshipSummary = (
  row: TaskRelationshipSummaryRow,
): TaskRelationshipSummary => ({
  id: row.id,
  scope_id: row.scope_id,
  status: row.status,
  title: row.title,
})

export const loadDirectDependencies = (
  taskId: string,
): Effect.Effect<readonly TaskRelationshipSummary[], PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const rows = yield* db.query(
      `SELECT t.id, t.scope_id, t.status, t.title, t.created_at
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.depends_on_task_id
       WHERE td.task_id = ?
       ORDER BY t.created_at ASC, t.id ASC`,
      [taskId],
    )

    return yield* Effect.forEach(rows, decodeTaskRelationshipSummaryRow).pipe(
      Effect.map((decodedRows) => decodedRows.map(toTaskRelationshipSummary)),
    )
  })

export const loadDirectDependents = (
  taskId: string,
): Effect.Effect<readonly TaskRelationshipSummary[], PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const rows = yield* db.query(
      `SELECT t.id, t.scope_id, t.status, t.title, t.created_at
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.task_id
       WHERE td.depends_on_task_id = ?
       ORDER BY t.created_at ASC, t.id ASC`,
      [taskId],
    )

    return yield* Effect.forEach(rows, decodeTaskRelationshipSummaryRow).pipe(
      Effect.map((decodedRows) => decodedRows.map(toTaskRelationshipSummary)),
    )
  })

export const loadUnresolvedDependencyIds = (
  taskId: string,
): Effect.Effect<readonly string[], PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const rows = yield* db.query(
      `SELECT t.id, t.created_at
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.depends_on_task_id
       WHERE td.task_id = ?
         AND t.status <> 'done'
       ORDER BY t.created_at ASC, t.id ASC`,
      [taskId],
    )

    return yield* Effect.forEach(rows, decodeTaskIdRow).pipe(
      Effect.map((decodedRows) => decodedRows.map((row) => row.id)),
    )
  })

export const loadSupersedesSummary = (
  taskId: string,
): Effect.Effect<TaskRelationshipSummary | null, PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const rows = yield* db.query(
      `SELECT t.id, t.scope_id, t.status, t.title, t.created_at
       FROM task_supersessions ts
       JOIN tasks t ON t.id = ts.old_task_id
       WHERE ts.new_task_id = ?`,
      [taskId],
    )

    if (rows.length === 0) {
      return null
    }

    const row = yield* decodeTaskRelationshipSummaryRow(rows[0]!)
    return toTaskRelationshipSummary(row)
  })

export const loadSupersededBySummary = (
  taskId: string,
): Effect.Effect<TaskRelationshipSummary | null, PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const rows = yield* db.query(
      `SELECT t.id, t.scope_id, t.status, t.title, t.created_at
       FROM task_supersessions ts
       JOIN tasks t ON t.id = ts.new_task_id
       WHERE ts.old_task_id = ?`,
      [taskId],
    )

    if (rows.length === 0) {
      return null
    }

    const row = yield* decodeTaskRelationshipSummaryRow(rows[0]!)
    return toTaskRelationshipSummary(row)
  })

export const computeTaskClaimability = (
  task: Pick<TaskRow, "status">,
  unresolvedDependencyIds: readonly string[],
  supersededBy: TaskRelationshipSummary | null,
): TaskClaimability => ({
  claimable:
    task.status === "queued" &&
    unresolvedDependencyIds.length === 0 &&
    supersededBy === null,
  unresolvedDependencyIds,
})
