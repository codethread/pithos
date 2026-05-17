import { PithosError } from "./errors.js";

export type ChainCapability = "triage" | "design" | "execute" | "review" | "escalate" | "intake";
export type ChainPolicy = "auto" | "none" | "held" | "source";
export type SourceKind = "chain_source" | "repair_source";

export interface ChainTask {
	readonly id: string;
	readonly capability: ChainCapability;
	readonly status: string;
}

export interface ChainGraphInput {
	readonly tasks: readonly ChainTask[];
	readonly dependencies: readonly DependencyEdge[];
	readonly sources: readonly SourceEdge[];
	readonly supersessions: readonly SupersessionEdge[];
}

export interface DependencyEdge {
	readonly taskId: string;
	readonly dependsOnTaskId: string;
}

export interface SourceEdge {
	readonly taskId: string;
	readonly sourceTaskId: string;
	readonly sourceKind?: SourceKind;
}

export interface SupersessionEdge {
	readonly oldTaskId: string;
	readonly newTaskId: string;
}

export type ChainAppliedReason =
	| "none_selected"
	| "flat_no_held_task"
	| "depends_on_held"
	| "source_from_held"
	| "depends_on_source"
	| "flat_held_escalation_without_source"
	| "flat_escalation_from_escalation";

export interface ChainPolicyDecision {
	readonly policy: ChainPolicy;
	readonly applied: ChainAppliedReason;
	readonly heldTaskId: string | null;
	readonly sourceTaskId: string | null;
	readonly sourceKind: SourceKind | null;
	readonly implicitDependencyIds: readonly string[];
}

const isEscalation = (capability: ChainCapability): boolean => capability === "escalate";

const chainValidationError = (message: string): PithosError =>
	new PithosError({ code: "VALIDATION_ERROR", message });

const assertKnownTaskId = (taskIds: ReadonlySet<string>, taskId: string, context: string): void => {
	if (!taskIds.has(taskId))
		throw chainValidationError(`${context} references unknown task: ${taskId}`);
};

const validateGraph = (graph: ChainGraphInput, seedTaskIds: readonly string[] = []): void => {
	const taskIds = new Set(graph.tasks.map((task) => task.id));
	for (const taskId of seedTaskIds) assertKnownTaskId(taskIds, taskId, "graph seed");
	for (const edge of graph.dependencies) {
		assertKnownTaskId(taskIds, edge.taskId, "dependency edge");
		assertKnownTaskId(taskIds, edge.dependsOnTaskId, "dependency edge");
	}
	for (const edge of graph.sources) {
		assertKnownTaskId(taskIds, edge.taskId, "source edge");
		assertKnownTaskId(taskIds, edge.sourceTaskId, "source edge");
	}
	for (const edge of graph.supersessions) {
		assertKnownTaskId(taskIds, edge.oldTaskId, "supersession edge");
		assertKnownTaskId(taskIds, edge.newTaskId, "supersession edge");
	}
};

export const resolveChainPolicy = (input: {
	readonly policy: ChainPolicy;
	readonly newTaskCapability: ChainCapability;
	readonly heldTask: ChainTask | null;
	readonly heldSource: { readonly taskId: string; readonly kind: SourceKind } | null;
}): ChainPolicyDecision => {
	const heldTaskId = input.heldTask?.id ?? null;
	const base = {
		policy: input.policy,
		heldTaskId,
		sourceTaskId: input.heldSource?.taskId ?? null,
		sourceKind: input.heldSource?.kind ?? null,
	} as const;

	if (input.policy === "none") {
		return {
			...base,
			applied: "none_selected",
			sourceTaskId: null,
			sourceKind: null,
			implicitDependencyIds: [],
		};
	}

	if (input.heldTask === null) {
		if (input.policy === "auto") {
			return { ...base, applied: "flat_no_held_task", implicitDependencyIds: [] };
		}
		throw chainValidationError(`--chain ${input.policy} requires a held task`);
	}

	if (input.policy === "held") {
		if (isEscalation(input.newTaskCapability)) {
			throw chainValidationError("--chain held cannot be used when enqueueing escalation tasks");
		}
		return {
			...base,
			sourceTaskId: null,
			sourceKind: null,
			applied: "depends_on_held",
			implicitDependencyIds: [input.heldTask.id],
		};
	}

	if (input.policy === "source") {
		if (isEscalation(input.newTaskCapability)) {
			throw chainValidationError("--chain source cannot be used when enqueueing escalation tasks");
		}
		if (input.heldSource === null) {
			throw chainValidationError("--chain source requires the held task to have a source link");
		}
		if (input.heldSource.kind !== "chain_source") {
			throw chainValidationError(
				"--chain source requires a chain_source; repair_source must be superseded or replanned",
			);
		}
		return {
			...base,
			applied: "depends_on_source",
			implicitDependencyIds: [input.heldSource.taskId],
		};
	}

	if (!isEscalation(input.heldTask.capability) && !isEscalation(input.newTaskCapability)) {
		return {
			...base,
			sourceTaskId: null,
			sourceKind: null,
			applied: "depends_on_held",
			implicitDependencyIds: [input.heldTask.id],
		};
	}
	if (!isEscalation(input.heldTask.capability) && isEscalation(input.newTaskCapability)) {
		return {
			...base,
			sourceTaskId: input.heldTask.id,
			sourceKind: "chain_source",
			applied: "source_from_held",
			implicitDependencyIds: [],
		};
	}
	if (isEscalation(input.heldTask.capability) && !isEscalation(input.newTaskCapability)) {
		if (input.heldSource === null) {
			return { ...base, applied: "flat_held_escalation_without_source", implicitDependencyIds: [] };
		}
		if (input.heldSource.kind !== "chain_source") {
			throw chainValidationError(
				"--chain auto cannot continue from repair_source; supersede or replan the source task instead",
			);
		}
		return {
			...base,
			applied: "depends_on_source",
			implicitDependencyIds: [input.heldSource.taskId],
		};
	}
	return {
		...base,
		sourceTaskId: null,
		sourceKind: null,
		applied: "flat_escalation_from_escalation",
		implicitDependencyIds: [],
	};
};

export const finalDependencyIds = (input: {
	readonly manualDependencyIds: readonly string[];
	readonly implicitDependencyIds: readonly string[];
}): readonly string[] => {
	const dependencyIds = [...input.manualDependencyIds, ...input.implicitDependencyIds];
	const seen = new Set<string>();
	for (const id of dependencyIds) {
		if (seen.has(id)) throw chainValidationError(`duplicate dependency task id: ${id}`);
		seen.add(id);
	}
	return dependencyIds;
};

export const assertDependencyAcyclic = (dependencies: readonly DependencyEdge[]): void => {
	const outgoing = new Map<string, string[]>();
	for (const edge of dependencies) {
		outgoing.set(edge.taskId, [...(outgoing.get(edge.taskId) ?? []), edge.dependsOnTaskId]);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw chainValidationError("task dependency cycle detected");
		if (visited.has(id)) return;
		visiting.add(id);
		for (const next of outgoing.get(id) ?? []) visit(next);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of outgoing.keys()) visit(id);
};

export const upstreamDependencyLineage = (
	graph: ChainGraphInput,
	taskId: string,
): readonly string[] => {
	validateGraph(graph, [taskId]);
	const parents = new Map<string, string[]>();
	for (const edge of graph.dependencies) {
		parents.set(edge.taskId, [...(parents.get(edge.taskId) ?? []), edge.dependsOnTaskId]);
	}
	const result = new Set<string>();
	const queue = [taskId];
	let index = 0;
	while (index < queue.length) {
		const current = queue[index];
		if (current === undefined) throw chainValidationError("missing lineage queue item");
		index += 1;
		for (const parent of parents.get(current) ?? []) {
			if (result.has(parent)) continue;
			result.add(parent);
			queue.push(parent);
		}
	}
	return [...result].sort();
};

export const unresolvedDependencyIds = (
	graph: ChainGraphInput,
	taskId: string,
): readonly string[] => {
	validateGraph(graph, [taskId]);
	const tasks = new Map(graph.tasks.map((task) => [task.id, task]));
	return graph.dependencies
		.filter((edge) => edge.taskId === taskId)
		.filter((edge) => tasks.get(edge.dependsOnTaskId)?.status !== "done")
		.map((edge) => edge.dependsOnTaskId)
		.sort();
};

export const graphClosure = (
	graph: ChainGraphInput,
	seedTaskIds: readonly string[],
): readonly string[] => {
	validateGraph(graph, seedTaskIds);
	const ids = new Set(seedTaskIds);
	let changed = true;
	while (changed) {
		changed = false;
		const add = (id: string): void => {
			if (!ids.has(id)) {
				ids.add(id);
				changed = true;
			}
		};
		for (const edge of graph.dependencies) {
			if (ids.has(edge.taskId) || ids.has(edge.dependsOnTaskId)) {
				add(edge.taskId);
				add(edge.dependsOnTaskId);
			}
		}
		for (const edge of graph.sources) {
			if (ids.has(edge.taskId) || ids.has(edge.sourceTaskId)) {
				add(edge.taskId);
				add(edge.sourceTaskId);
			}
		}
		for (const edge of graph.supersessions) {
			if (ids.has(edge.oldTaskId) || ids.has(edge.newTaskId)) {
				add(edge.oldTaskId);
				add(edge.newTaskId);
			}
		}
	}
	return [...ids].sort();
};
