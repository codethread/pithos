import { Effect } from "effect"
import { decodeArtifactRow, decodeRunRow, decodeTaskRow } from "../db/helpers.ts"
import type { TaskRow } from "../db/rows.ts"
import {
  computeTaskClaimability,
  loadCurrentTaskGraph,
  loadDirectDependencies,
  loadDirectDependents,
  loadScopeTaskGraph,
  loadSupersededBySummary,
  loadSupersedesSummary,
  loadTaskGraph,
  loadUnresolvedDependencies,
  type GraphNode,
  type TaskGraph,
} from "../domain/task-graph.ts"
import { toRunOutput } from "../domain/run.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"

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

export const inspectTaskCommand = (
  id: string,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    const rows = yield* db.query(`SELECT * FROM tasks WHERE id = ?`, [id])
    if (rows.length === 0) {
      yield* Effect.fail(new PithosError({ code: "NOT_FOUND", message: `Task not found: ${id}` }))
    }

    const task = yield* decodeTaskRow(rows[0]!)
    const dependencies = yield* loadDirectDependencies(id)
    const dependents = yield* loadDirectDependents(id)
    const unresolvedBlockers = yield* loadUnresolvedDependencies(id)
    const unresolvedDependencyIds = unresolvedBlockers.map((blocker) => blocker.id)
    const supersedes = yield* loadSupersedesSummary(id)
    const supersededBy = yield* loadSupersededBySummary(id)
    const claimability = computeTaskClaimability(task, unresolvedDependencyIds, supersededBy)

    const artifacts = yield* db.query(
      `SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
      [id],
    ).pipe(Effect.flatMap((artifactRows) => Effect.forEach(artifactRows, decodeArtifactRow)))

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
  }).pipe(Effect.withLogSpan("pithos.task.inspect"), withCommandObservability("task.inspect"))

export interface InspectGraphSelectorArgs {
  readonly taskId: string | undefined
  readonly scopeId: string | undefined
  readonly all: boolean
}

export type InspectGraphSelector =
  | { readonly kind: "task"; readonly value: string }
  | { readonly kind: "scope"; readonly value: string }
  | { readonly kind: "all" }

export const decodeInspectGraphSelector = (
  args: InspectGraphSelectorArgs,
): Effect.Effect<InspectGraphSelector, PithosError> =>
  Effect.gen(function* () {
    const selectedCount = [args.taskId !== undefined, args.scopeId !== undefined, args.all].filter(Boolean)
      .length

    if (selectedCount !== 1) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "graph inspect requires exactly one selector: choose one of --task, --scope, or --all",
        }),
      )
    }

    if (args.taskId !== undefined) {
      return { kind: "task", value: args.taskId } as const
    }
    if (args.scopeId !== undefined) {
      return { kind: "scope", value: args.scopeId } as const
    }
    return { kind: "all" } as const
  })

export const filterTerminalChains = (graph: TaskGraph): TaskGraph => {
  if (graph.nodes.length === 0) return graph

  const supersededByLookup = new Map<string, GraphNode>()
  for (const node of graph.nodes) {
    if (node.supersedes_task_id !== null) {
      supersededByLookup.set(node.supersedes_task_id, node)
    }
  }

  const supersessionParticipantIds = new Set<string>()
  for (const node of graph.nodes) {
    if (
      node.supersedes_task_id !== null ||
      node.superseded_by_task_id !== null ||
      supersededByLookup.has(node.id)
    ) {
      supersessionParticipantIds.add(node.id)
    }
  }

  const terminalStatuses = new Set(["done", "cancelled"])
  const terminalNodeIds = new Set<string>()

  const chainRoots = graph.nodes.filter(
    (node) =>
      node.supersedes_task_id === null &&
      (node.superseded_by_task_id !== null || supersededByLookup.has(node.id)),
  )

  for (const root of chainRoots) {
    const chainNodes: GraphNode[] = [root]
    let current: GraphNode | undefined = supersededByLookup.get(root.id)
    while (current !== undefined) {
      chainNodes.push(current)
      current = supersededByLookup.get(current.id)
    }

    if (chainNodes.every((node) => terminalStatuses.has(node.status))) {
      for (const node of chainNodes) {
        terminalNodeIds.add(node.id)
      }
    }
  }

  for (const node of graph.nodes) {
    if (!supersessionParticipantIds.has(node.id) && terminalStatuses.has(node.status)) {
      terminalNodeIds.add(node.id)
    }
  }

  if (terminalNodeIds.size === 0) return graph

  return {
    nodes: graph.nodes.filter((node) => !terminalNodeIds.has(node.id)),
    edges: graph.edges.filter(
      (edge) => !terminalNodeIds.has(edge.from_task_id) && !terminalNodeIds.has(edge.to_task_id),
    ),
  }
}

export const renderGraphFlat = (graph: TaskGraph): string => {
  if (graph.nodes.length === 0) return ""

  const supersededByLookup = new Map<string, GraphNode>()
  for (const node of graph.nodes) {
    if (node.supersedes_task_id !== null) {
      supersededByLookup.set(node.supersedes_task_id, node)
    }
  }

  const supersessionRoots = graph.nodes.filter(
    (node) =>
      node.supersedes_task_id === null &&
      (node.superseded_by_task_id !== null || supersededByLookup.has(node.id)),
  )

  const standaloneNodes = graph.nodes.filter(
    (node) =>
      node.supersedes_task_id === null &&
      node.superseded_by_task_id === null &&
      !supersededByLookup.has(node.id),
  )

  if (supersessionRoots.length === 0 && standaloneNodes.length === 0) {
    return ""
  }

  const renderChain = (root: GraphNode): string => {
    const lines: string[] = []
    let current: GraphNode | undefined = root
    let depth = 0
    while (current !== undefined) {
      lines.push(`${"  ".repeat(depth)}[${current.status}] ${current.title}`)
      current = supersededByLookup.get(current.id)
      depth += 1
    }
    return lines.join("\n")
  }

  const chainBlocks = supersessionRoots.map(renderChain)
  const standaloneBlocks = standaloneNodes.map((node) => `[${node.status}] ${node.title}`)
  return [...chainBlocks, ...standaloneBlocks].join("\n\n")
}

export const inspectGraphCommand = (
  selector: InspectGraphSelector,
  flat: boolean,
  dump: boolean,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const output = yield* OutputService
    const graph =
      selector.kind === "task"
        ? yield* loadTaskGraph(selector.value)
        : selector.kind === "scope"
          ? yield* loadScopeTaskGraph(selector.value)
          : yield* loadCurrentTaskGraph()

    if (flat) {
      const displayGraph = dump ? graph : filterTerminalChains(graph)
      yield* output.print(renderGraphFlat(displayGraph))
      return
    }

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
  }).pipe(Effect.withLogSpan("pithos.graph.inspect"), withCommandObservability("graph.inspect"))

export const inspectRunCommand = (
  id: string,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    const rows = yield* db.query(`SELECT * FROM runs WHERE id = ?`, [id])
    if (rows.length === 0) {
      yield* Effect.fail(new PithosError({ code: "NOT_FOUND", message: `Run not found: ${id}` }))
    }

    const run = yield* decodeRunRow(rows[0]!)
    yield* output.print(JSON.stringify({ ok: true, run: toRunOutput(run) }))
  }).pipe(Effect.withLogSpan("pithos.run.inspect"), withCommandObservability("run.inspect"))
