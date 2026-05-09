import { Effect, Schema } from "effect";
import { ArtifactRow, TaskRow } from "../db/rows.ts";
import {
	computeTaskClaimability,
	loadDirectDependencies,
	loadDirectDependents,
	loadCurrentTaskGraph,
	loadScopeTaskGraph,
	loadSupersededBySummary,
	loadSupersedesSummary,
	loadTaskGraph,
	loadUnresolvedDependencies,
	type GraphNode,
	type TaskGraph,
} from "../domain/task-graph.ts";
import { DbService } from "../services/db.ts";
import { OutputService } from "../services/output.ts";
import { PithosError } from "../errors/errors.ts";
import { withCommandObservability } from "../layers/metrics.ts";
import { sql } from "../db/sql.ts";

const decodeTaskRow = (row: unknown): Effect.Effect<TaskRow, PithosError> =>
	Schema.decodeUnknown(TaskRow)(row).pipe(
		Effect.mapError(
			() =>
				new PithosError({
					code: "INTERNAL_ERROR",
					message: "TaskRow shape violation from DB",
				}),
		),
	);

const decodeArtifactRow = (row: unknown): Effect.Effect<ArtifactRow, PithosError> =>
	Schema.decodeUnknown(ArtifactRow)(row).pipe(
		Effect.mapError(
			() =>
				new PithosError({
					code: "INTERNAL_ERROR",
					message: "ArtifactRow shape violation from DB",
				}),
		),
	);

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
});

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
		const db = yield* DbService;
		const output = yield* OutputService;

		const rows = yield* db.query(sql`SELECT * FROM scopes WHERE id = ?`, [id]);

		if (rows.length === 0) {
			yield* Effect.fail(new PithosError({ code: "NOT_FOUND", message: `Scope not found: ${id}` }));
			return;
		}

		yield* output.print(JSON.stringify({ ok: true, scope: rows[0] }));
	}).pipe(Effect.withLogSpan("pithos.inspect.scope"), withCommandObservability("inspect.scope"));

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
		const db = yield* DbService;
		const output = yield* OutputService;

		const rows = yield* db.query(sql`SELECT * FROM tasks WHERE id = ?`, [id]);

		if (rows.length === 0) {
			yield* Effect.fail(new PithosError({ code: "NOT_FOUND", message: `Task not found: ${id}` }));
			return;
		}

		const task = yield* decodeTaskRow(rows[0]!);
		const dependencies = yield* loadDirectDependencies(id);
		const dependents = yield* loadDirectDependents(id);
		const unresolvedBlockers = yield* loadUnresolvedDependencies(id);
		const unresolvedDependencyIds = unresolvedBlockers.map((b) => b.id);
		const supersedes = yield* loadSupersedesSummary(id);
		const supersededBy = yield* loadSupersededBySummary(id);
		const claimability = computeTaskClaimability(task, unresolvedDependencyIds, supersededBy);

		const artifacts = yield* db
			.query(sql`SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC`, [id])
			.pipe(Effect.flatMap((artifactRows) => Effect.forEach(artifactRows, decodeArtifactRow)));

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
		);
	}).pipe(Effect.withLogSpan("pithos.inspect.task"), withCommandObservability("inspect.task"));

export type InspectGraphSelector =
	| { readonly kind: "task"; readonly value: string }
	| { readonly kind: "scope"; readonly value: string }
	| { readonly kind: "all" };

export interface InspectGraphSelectorArgs {
	readonly taskId: string | undefined;
	readonly scopeId: string | undefined;
	readonly all: boolean;
	readonly current: boolean;
}

export const decodeInspectGraphSelector = (
	args: InspectGraphSelectorArgs,
): Effect.Effect<InspectGraphSelector, PithosError> =>
	Effect.gen(function* () {
		const allEffective = args.all || args.current;
		const selectedCount = [
			args.taskId !== undefined,
			args.scopeId !== undefined,
			allEffective,
		].filter(Boolean).length;

		if (selectedCount !== 1) {
			yield* Effect.fail(
				new PithosError({
					code: "VALIDATION_ERROR",
					message:
						"inspect graph requires exactly one selector: choose one of --task, --scope, or --all",
				}),
			);
			return yield* Effect.never;
		}

		if (args.taskId !== undefined) {
			return { kind: "task", value: args.taskId } as const;
		}
		if (args.scopeId !== undefined) {
			return { kind: "scope", value: args.scopeId } as const;
		}
		return { kind: "all" } as const;
	});

/**
 * Filter out fully-terminal chains and standalone terminal nodes from a task graph.
 * Pure function, no services.
 *
 * A "fully-terminal chain" is a supersession chain where every node has status
 * "done" or "cancelled". A "standalone terminal" node has no supersession links
 * and status "done" or "cancelled". Both are removed from the returned graph.
 */
export const filterTerminalChains = (graph: TaskGraph): TaskGraph => {
	if (graph.nodes.length === 0) return graph;

	// supersededByLookup: old_task_id → the newer node that superseded it
	const supersededByLookup = new Map<string, GraphNode>();
	for (const node of graph.nodes) {
		if (node.supersedes_task_id !== null) {
			supersededByLookup.set(node.supersedes_task_id, node);
		}
	}

	// Nodes that participate in any supersession relationship
	const supersessionParticipantIds = new Set<string>();
	for (const node of graph.nodes) {
		if (
			node.supersedes_task_id !== null ||
			node.superseded_by_task_id !== null ||
			supersededByLookup.has(node.id)
		) {
			supersessionParticipantIds.add(node.id);
		}
	}

	const terminalStatuses = new Set(["done", "cancelled"]);
	const terminalNodeIds = new Set<string>();

	// Chain roots: nodes that start a supersession chain (not superseded but have a replacement)
	// Uses same logic as renderGraphFlat: supersedes_task_id === null AND part of a supersession chain
	const chainRoots = graph.nodes.filter(
		(n) =>
			n.supersedes_task_id === null &&
			(n.superseded_by_task_id !== null || supersededByLookup.has(n.id)),
	);

	for (const root of chainRoots) {
		// Walk the chain from root to leaf
		const chainNodes: GraphNode[] = [root];
		let current: GraphNode | undefined = supersededByLookup.get(root.id);
		while (current !== undefined) {
			chainNodes.push(current);
			current = supersededByLookup.get(current.id);
		}

		// If every node in the chain is terminal, mark the whole chain for removal
		if (chainNodes.every((n) => terminalStatuses.has(n.status))) {
			for (const node of chainNodes) {
				terminalNodeIds.add(node.id);
			}
		}
	}

	// Standalone nodes (no supersession involvement) with terminal status
	for (const node of graph.nodes) {
		if (!supersessionParticipantIds.has(node.id) && terminalStatuses.has(node.status)) {
			terminalNodeIds.add(node.id);
		}
	}

	if (terminalNodeIds.size === 0) return graph;

	return {
		nodes: graph.nodes.filter((n) => !terminalNodeIds.has(n.id)),
		edges: graph.edges.filter(
			(e) => !terminalNodeIds.has(e.from_task_id) && !terminalNodeIds.has(e.to_task_id),
		),
	};
};

/**
 * Renders supersession chains and standalone tasks as plain text. Pure function, no services.
 *
 * Tasks in a supersession relationship are rendered as indented chains. Standalone
 * tasks (no supersession links at all) appear as single-line entries at depth 0.
 * Dependency-only nodes that have no supersession involvement are omitted.
 * Multiple entries are separated by blank lines.
 */
export const renderGraphFlat = (graph: TaskGraph): string => {
	if (graph.nodes.length === 0) return "";

	// supersededByLookup: old_task_id → the newer node that superseded it
	const supersededByLookup = new Map<string, GraphNode>();
	for (const node of graph.nodes) {
		if (node.supersedes_task_id !== null) {
			supersededByLookup.set(node.supersedes_task_id, node);
		}
	}

	// Chain roots: nodes that start a supersession chain (not a replacement themselves)
	const supersessionRoots = graph.nodes.filter(
		(n) =>
			n.supersedes_task_id === null &&
			(n.superseded_by_task_id !== null || supersededByLookup.has(n.id)),
	);

	// Standalone nodes: no supersession relationship in either direction
	const standaloneNodes = graph.nodes.filter(
		(n) =>
			n.supersedes_task_id === null &&
			n.superseded_by_task_id === null &&
			!supersededByLookup.has(n.id),
	);

	if (supersessionRoots.length === 0 && standaloneNodes.length === 0) return "";

	const renderChain = (root: GraphNode): string => {
		const lines: string[] = [];
		let current: GraphNode | undefined = root;
		let depth = 0;
		while (current !== undefined) {
			lines.push(`${"  ".repeat(depth)}[${current.status}] ${current.title}`);
			current = supersededByLookup.get(current.id);
			depth++;
		}
		return lines.join("\n");
	};

	const chainBlocks = supersessionRoots.map(renderChain);
	const standaloneBlocks = standaloneNodes.map((n) => `[${n.status}] ${n.title}`);

	return [...chainBlocks, ...standaloneBlocks].join("\n\n");
};

/**
 * `pithos inspect graph --task <id> | --scope <scope-id> | --all`
 *
 * Returns a closed transitive dependency/supersession graph for the selected seed set.
 */
export const inspectGraphCommand = (
	selector: InspectGraphSelector,
	flat: boolean,
	dump: boolean,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
	Effect.gen(function* () {
		const output = yield* OutputService;
		const graph =
			selector.kind === "task"
				? yield* loadTaskGraph(selector.value)
				: selector.kind === "scope"
					? yield* loadScopeTaskGraph(selector.value)
					: yield* loadCurrentTaskGraph();

		if (flat) {
			const displayGraph = !dump ? filterTerminalChains(graph) : graph;
			yield* output.print(renderGraphFlat(displayGraph));
		} else {
			yield* output.print(
				JSON.stringify({
					ok: true,
					graph: {
						selector,
						nodes: graph.nodes,
						edges: graph.edges,
					},
				}),
			);
		}
	}).pipe(Effect.withLogSpan("pithos.inspect.graph"), withCommandObservability("inspect.graph"));

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
		const db = yield* DbService;
		const output = yield* OutputService;

		const rows = yield* db.query(sql`SELECT * FROM runs WHERE id = ?`, [id]);

		if (rows.length === 0) {
			yield* Effect.fail(new PithosError({ code: "NOT_FOUND", message: `Run not found: ${id}` }));
			return;
		}

		yield* output.print(JSON.stringify({ ok: true, run: rows[0] }));
	}).pipe(Effect.withLogSpan("pithos.inspect.run"), withCommandObservability("inspect.run"));

export const INSPECT_HELP = `pithos inspect - Inspect a pithos entity

Usage:
  pithos inspect scope <id>
  pithos inspect run <id>
  pithos inspect task <id>
  pithos inspect graph --task <id>
  pithos inspect graph --scope <scope-id>
  pithos inspect graph --all

Options:
  --help, -h    Show this help

Subcommands:
  scope <id>             Show a scope by ID
  run <id>               Show a run by ID
  task <id>              Show a task by ID with direct dependencies, dependents, blockers, supersession links, and artifacts
  graph --task <id>      Show a closed transitive dependency/supersession graph around one task
  graph --scope <id>     Show a closed transitive dependency/supersession graph around a scope's non-cancelled tasks
  graph --all            Show the closed transitive dependency/supersession graph for all non-cancelled tasks
  graph --flat           Render a plain-text tree (opt-in text mode; hides completed chains by default)
  graph --dump           Show all chains including completed ones (only meaningful with --flat)

Output (JSON):
  { "ok": true, "scope": { "id": "...", "kind": "...", ... } }
  { "ok": true, "run": { "id": "...", "agent_kind": "...", ... } }
  { "ok": true, "task": { "id": "...", "status": "queued", "claimable": false, "unresolved_dependency_ids": [ ... ], ... }, "dependencies": [ ... ], "dependents": [ ... ], "unresolved_blockers": [ { "id": "...", "scope_id": "...", "status": "queued", "title": "Blocker title" } ], "supersedes": null, "superseded_by": null, "artifacts": [ ... ] }
  { "ok": true, "graph": { "selector": { "kind": "task", "value": "task_..." } | { "kind": "scope", "value": "repo:..." } | { "kind": "all" }, "nodes": [ { "id": "...", "scope_id": "...", "capability": "...", "status": "...", "title": "...", "claimable": false, "unresolved_dependency_ids": [ ... ], "supersedes_task_id": null, "superseded_by_task_id": null } ], "edges": [ { "kind": "depends_on", "from_task_id": "...", "to_task_id": "...", "satisfied": true }, { "kind": "supersedes", "from_task_id": "...", "to_task_id": "..." } ] } }

Examples:
  pithos inspect scope global
  pithos inspect scope repo:work/perkbox-services/protobuf
  pithos inspect run run_abc123
  pithos inspect task task_abc123
  pithos inspect graph --task task_abc123
  pithos inspect graph --scope repo:work/perkbox-services/protobuf
  pithos inspect graph --all
  pithos inspect graph --all --flat
  pithos inspect graph --all --flat --dump

Exit codes: 0 success | 2 validation error | 3 not found
`;
