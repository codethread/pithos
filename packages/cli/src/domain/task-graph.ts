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

export interface GraphNode {
  readonly id: string
  readonly scope_id: string
  readonly capability: string
  readonly status: string
  readonly title: string
  readonly claimable: boolean
  readonly unresolved_dependency_ids: readonly string[]
  readonly supersedes_task_id: string | null
  readonly superseded_by_task_id: string | null
}

export type GraphEdge =
  | {
      readonly kind: "depends_on"
      readonly from_task_id: string
      readonly to_task_id: string
      readonly satisfied: boolean
    }
  | {
      readonly kind: "supersedes"
      readonly from_task_id: string
      readonly to_task_id: string
    }

export interface TaskGraph {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
}

class IdRow extends Schema.Class<IdRow>("IdRow")({
  id: Schema.String,
}) {}

class TaskRelationshipSummaryRow extends Schema.Class<TaskRelationshipSummaryRow>(
  "TaskRelationshipSummaryRow",
)({
  id: Schema.String,
  scope_id: Schema.String,
  status: Schema.String,
  title: Schema.String,
  created_at: Schema.String,
}) {}

class GraphTaskRow extends Schema.Class<GraphTaskRow>("GraphTaskRow")({
  id: Schema.String,
  scope_id: Schema.String,
  capability: Schema.String,
  status: Schema.String,
  title: Schema.String,
  created_at: Schema.String,
}) {}

class GraphDependencyEdgeRow extends Schema.Class<GraphDependencyEdgeRow>(
  "GraphDependencyEdgeRow",
)({
  from_task_id: Schema.String,
  to_task_id: Schema.String,
  blocker_status: Schema.String,
}) {}

class GraphSupersessionEdgeRow extends Schema.Class<GraphSupersessionEdgeRow>(
  "GraphSupersessionEdgeRow",
)({
  from_task_id: Schema.String,
  to_task_id: Schema.String,
}) {}

const sortStrings = (left: string, right: string): number => left.localeCompare(right)

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

const decodeGraphTaskRow = (row: unknown): Effect.Effect<GraphTaskRow, PithosError> =>
  Schema.decodeUnknown(GraphTaskRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "graph task row shape violation",
        }),
    ),
  )

const decodeGraphDependencyEdgeRow = (
  row: unknown,
): Effect.Effect<GraphDependencyEdgeRow, PithosError> =>
  Schema.decodeUnknown(GraphDependencyEdgeRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "graph dependency edge row shape violation",
        }),
    ),
  )

const decodeGraphSupersessionEdgeRow = (
  row: unknown,
): Effect.Effect<GraphSupersessionEdgeRow, PithosError> =>
  Schema.decodeUnknown(GraphSupersessionEdgeRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "graph supersession edge row shape violation",
        }),
    ),
  )

const makeSqlPlaceholders = (count: number): string =>
  Array.from({ length: count }, () => "?").join(", ")

const toTaskRelationshipSummary = (
  row: TaskRelationshipSummaryRow,
): TaskRelationshipSummary => ({
  id: row.id,
  scope_id: row.scope_id,
  status: row.status,
  title: row.title,
})

const sortGraphEdges = (left: GraphEdge, right: GraphEdge): number =>
  left.kind.localeCompare(right.kind) ||
  left.from_task_id.localeCompare(right.from_task_id) ||
  left.to_task_id.localeCompare(right.to_task_id)

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

export const LOAD_UNRESOLVED_DEPENDENCIES_SQL = `SELECT t.id, t.scope_id, t.status, t.title, t.created_at
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.depends_on_task_id
       WHERE td.task_id = ?
         AND t.status <> 'done'
       ORDER BY t.created_at ASC, t.id ASC`

export const loadUnresolvedDependencies = (
  taskId: string,
): Effect.Effect<readonly TaskRelationshipSummary[], PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const rows = yield* db.query(LOAD_UNRESOLVED_DEPENDENCIES_SQL, [taskId])

    return yield* Effect.forEach(rows, decodeTaskRelationshipSummaryRow).pipe(
      Effect.map((decodedRows) => decodedRows.map(toTaskRelationshipSummary)),
    )
  })

export const loadUnresolvedDependencyIds = (
  taskId: string,
): Effect.Effect<readonly string[], PithosError, DbService> =>
  loadUnresolvedDependencies(taskId).pipe(
    Effect.map((dependencies) => dependencies.map((dependency) => dependency.id)),
  )

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

const loadTaskGraphConnectedTaskIds = (
  seedTaskIds: readonly string[],
): Effect.Effect<readonly string[], PithosError, DbService> =>
  Effect.gen(function* () {
    if (seedTaskIds.length === 0) {
      return []
    }

    const queue = [...seedTaskIds].sort(sortStrings)
    const seen = new Set(queue)

    while (queue.length > 0) {
      const currentTaskId = queue.shift()!

      const dependencies = yield* loadDirectDependencies(currentTaskId)
      const dependents = yield* loadDirectDependents(currentTaskId)
      const supersedes = yield* loadSupersedesSummary(currentTaskId)
      const supersededBy = yield* loadSupersededBySummary(currentTaskId)

      const neighbors = [
        ...dependencies,
        ...dependents,
        ...(supersedes === null ? [] : [supersedes]),
        ...(supersededBy === null ? [] : [supersededBy]),
      ]

      for (const neighbor of neighbors) {
        if (!seen.has(neighbor.id)) {
          seen.add(neighbor.id)
          queue.push(neighbor.id)
        }
      }
    }

    return [...seen].sort(sortStrings)
  })

const loadTaskGraphNodes = (
  taskIds: readonly string[],
): Effect.Effect<readonly GraphNode[], PithosError, DbService> =>
  Effect.gen(function* () {
    if (taskIds.length === 0) {
      return []
    }

    const db = yield* DbService
    const placeholders = makeSqlPlaceholders(taskIds.length)
    const rows = yield* db.query(
      `SELECT id, scope_id, capability, status, title, created_at
       FROM tasks
       WHERE id IN (${placeholders})
       ORDER BY created_at ASC, id ASC`,
      taskIds,
    )

    const tasks = yield* Effect.forEach(rows, decodeGraphTaskRow)

    return yield* Effect.forEach(tasks, (task) =>
      Effect.gen(function* () {
        const unresolvedDependencyIds = yield* loadUnresolvedDependencyIds(task.id)
        const supersedes = yield* loadSupersedesSummary(task.id)
        const supersededBy = yield* loadSupersededBySummary(task.id)
        const claimability = computeTaskClaimability(task, unresolvedDependencyIds, supersededBy)

        return {
          id: task.id,
          scope_id: task.scope_id,
          capability: task.capability,
          status: task.status,
          title: task.title,
          claimable: claimability.claimable,
          unresolved_dependency_ids: claimability.unresolvedDependencyIds,
          supersedes_task_id: supersedes?.id ?? null,
          superseded_by_task_id: supersededBy?.id ?? null,
        } satisfies GraphNode
      }),
    )
  })

const loadTaskGraphEdges = (
  taskIds: readonly string[],
): Effect.Effect<readonly GraphEdge[], PithosError, DbService> =>
  Effect.gen(function* () {
    if (taskIds.length === 0) {
      return []
    }

    const db = yield* DbService
    const placeholders = makeSqlPlaceholders(taskIds.length)
    const params = [...taskIds, ...taskIds]

    const dependencyRows = yield* db.query(
      `SELECT td.task_id AS from_task_id, td.depends_on_task_id AS to_task_id, dep.status AS blocker_status
       FROM task_dependencies td
       JOIN tasks dep ON dep.id = td.depends_on_task_id
       WHERE td.task_id IN (${placeholders})
         AND td.depends_on_task_id IN (${placeholders})`,
      params,
    )
    const supersessionRows = yield* db.query(
      `SELECT ts.new_task_id AS from_task_id, ts.old_task_id AS to_task_id
       FROM task_supersessions ts
       WHERE ts.new_task_id IN (${placeholders})
         AND ts.old_task_id IN (${placeholders})`,
      params,
    )

    const dependencyEdges = yield* Effect.forEach(
      dependencyRows,
      decodeGraphDependencyEdgeRow,
    ).pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              kind: "depends_on",
              from_task_id: row.from_task_id,
              to_task_id: row.to_task_id,
              satisfied: row.blocker_status === "done",
            }) satisfies GraphEdge,
        ),
      ),
    )

    const supersessionEdges = yield* Effect.forEach(
      supersessionRows,
      decodeGraphSupersessionEdgeRow,
    ).pipe(
      Effect.map((rows) =>
        rows.map(
          (row) =>
            ({
              kind: "supersedes",
              from_task_id: row.from_task_id,
              to_task_id: row.to_task_id,
            }) satisfies GraphEdge,
        ),
      ),
    )

    return [...dependencyEdges, ...supersessionEdges].sort(sortGraphEdges)
  })

const assertClosedTaskGraph = (graph: TaskGraph): Effect.Effect<void, PithosError> =>
  Effect.gen(function* () {
    const nodeIds = new Set(graph.nodes.map((node) => node.id))

    for (const node of graph.nodes) {
      for (const unresolvedDependencyId of node.unresolved_dependency_ids) {
        if (!nodeIds.has(unresolvedDependencyId)) {
          yield* Effect.fail(
            new PithosError({
              code: "INTERNAL_ERROR",
              message: `graph closure violation: unresolved dependency ${unresolvedDependencyId} missing for node ${node.id}`,
            }),
          )
          return
        }
      }

      if (node.supersedes_task_id !== null && !nodeIds.has(node.supersedes_task_id)) {
        yield* Effect.fail(
          new PithosError({
            code: "INTERNAL_ERROR",
            message: `graph closure violation: supersedes_task_id ${node.supersedes_task_id} missing for node ${node.id}`,
          }),
        )
        return
      }

      if (
        node.superseded_by_task_id !== null &&
        !nodeIds.has(node.superseded_by_task_id)
      ) {
        yield* Effect.fail(
          new PithosError({
            code: "INTERNAL_ERROR",
            message: `graph closure violation: superseded_by_task_id ${node.superseded_by_task_id} missing for node ${node.id}`,
          }),
        )
        return
      }
    }

    for (const edge of graph.edges) {
      if (!nodeIds.has(edge.from_task_id)) {
        yield* Effect.fail(
          new PithosError({
            code: "INTERNAL_ERROR",
            message: `graph closure violation: edge source ${edge.from_task_id} missing`,
          }),
        )
        return
      }
      if (!nodeIds.has(edge.to_task_id)) {
        yield* Effect.fail(
          new PithosError({
            code: "INTERNAL_ERROR",
            message: `graph closure violation: edge target ${edge.to_task_id} missing`,
          }),
        )
        return
      }
    }
  })

const dedupeTaskIds = (taskIds: readonly string[]): readonly string[] =>
  [...new Set(taskIds)].sort(sortStrings)

const buildTaskGraph = (
  taskIds: readonly string[],
): Effect.Effect<TaskGraph, PithosError, DbService> =>
  Effect.gen(function* () {
    const nodes = yield* loadTaskGraphNodes(taskIds)
    const edges = yield* loadTaskGraphEdges(taskIds)
    const graph = { nodes, edges } satisfies TaskGraph

    yield* assertClosedTaskGraph(graph)

    return graph
  })

const loadLiveTaskGraphConnectedTaskIds = (
  seedTaskIds: readonly string[],
): Effect.Effect<readonly string[], PithosError, DbService> =>
  Effect.gen(function* () {
    const queue = [...dedupeTaskIds(seedTaskIds)]
    const seen = new Set(queue)

    while (queue.length > 0) {
      const currentTaskId = queue.shift()!
      const unresolvedDependencies = yield* loadUnresolvedDependencies(currentTaskId)
      const supersedes = yield* loadSupersedesSummary(currentTaskId)
      const supersededBy = yield* loadSupersededBySummary(currentTaskId)
      const directDependencies = yield* loadDirectDependencies(currentTaskId)

      const neighbors = [
        ...directDependencies,
        ...unresolvedDependencies,
        ...(supersedes === null ? [] : [supersedes]),
        ...(supersededBy === null ? [] : [supersededBy]),
      ]

      for (const neighbor of neighbors) {
        if (!seen.has(neighbor.id)) {
          seen.add(neighbor.id)
          queue.push(neighbor.id)
        }
      }
    }

    return [...seen].sort(sortStrings)
  })

const loadTaskGraphFromSeedTaskIds = (
  seedTaskIds: readonly string[],
): Effect.Effect<TaskGraph, PithosError, DbService> =>
  Effect.gen(function* () {
    const taskIds = yield* loadTaskGraphConnectedTaskIds(dedupeTaskIds(seedTaskIds))
    return yield* buildTaskGraph(taskIds)
  })

const loadIdRows = (
  sql: string,
  params: readonly unknown[] = [],
): Effect.Effect<readonly string[], PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const rows = yield* db.query(sql, [...params])
    const decodedRows = yield* Effect.forEach(rows, decodeIdRow)
    return decodedRows.map((row) => row.id)
  })

export const loadTaskGraph = (
  seedTaskId: string,
): Effect.Effect<TaskGraph, PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const seedRows = yield* db.query(`SELECT id FROM tasks WHERE id = ?`, [seedTaskId])

    if (seedRows.length === 0) {
      yield* Effect.fail(
        new PithosError({
          code: "NOT_FOUND",
          message: `Task not found: ${seedTaskId}`,
        }),
      )
      return yield* Effect.never
    }
    yield* decodeIdRow(seedRows[0]!)

    return yield* loadTaskGraphFromSeedTaskIds([seedTaskId])
  })

export const loadScopeTaskGraph = (
  scopeId: string,
): Effect.Effect<TaskGraph, PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const scopeRows = yield* db.query(`SELECT id FROM scopes WHERE id = ?`, [scopeId])

    if (scopeRows.length === 0) {
      yield* Effect.fail(
        new PithosError({
          code: "NOT_FOUND",
          message: `Scope not found: ${scopeId}`,
        }),
      )
      return yield* Effect.never
    }
    yield* decodeIdRow(scopeRows[0]!)

    const seedTaskIds = yield* loadIdRows(
      `SELECT id
       FROM tasks
       WHERE scope_id = ?
         AND status <> 'cancelled'
       ORDER BY created_at ASC, id ASC`,
      [scopeId],
    )

    return yield* loadTaskGraphFromSeedTaskIds(seedTaskIds)
  })

export const loadLiveTaskGraph = (): Effect.Effect<TaskGraph, PithosError, DbService> =>
  loadIdRows(
    `SELECT id
     FROM tasks
     WHERE status <> 'cancelled'
     ORDER BY created_at ASC, id ASC`,
  ).pipe(
    Effect.flatMap(loadLiveTaskGraphConnectedTaskIds),
    Effect.flatMap(buildTaskGraph),
  )
