import type { Capability, SourceKind, TaskStatus } from "../db.js";
import type {
	ArtifactOutput,
	BriefingOutput,
	GraphInspectOutput,
	TaskDetailOutput,
	TaskInspectOutput,
	TaskInspectTaskOutput,
	TaskSourceSummaryOutput,
	TaskSummaryOutput,
} from "./types.js";

const effectiveTaskStatus = (task: {
	readonly status: TaskStatus;
	readonly unresolved_dependency_ids?: readonly string[];
}): string =>
	task.status === "queued" && (task.unresolved_dependency_ids ?? []).length > 0
		? "blocked"
		: task.status;

const taskTitleLine = (task: {
	readonly id: string;
	readonly capability: Capability;
	readonly status: TaskStatus;
	readonly title: string;
	readonly unresolved_dependency_ids?: readonly string[];
}): string => `${task.id} [${task.capability}] [${effectiveTaskStatus(task)}] ${task.title}`;

const ansi = {
	reset: "\u001b[0m",
	bold: "\u001b[1m",
	dim: "\u001b[2m",
	red: "\u001b[31m",
	green: "\u001b[32m",
	yellow: "\u001b[33m",
	blue: "\u001b[34m",
	cyan: "\u001b[36m",
};

const color = (enabled: boolean, code: string, text: string): string =>
	enabled ? `${code}${text}${ansi.reset}` : text;

const taskStatusColor = (status: TaskStatus): string => {
	switch (status) {
		case "queued":
			return ansi.yellow;
		case "claimed":
		case "running":
			return ansi.blue;
		case "done":
			return ansi.green;
		case "failed":
			return ansi.red;
		case "dead_letter":
			return `${ansi.bold}${ansi.red}`;
		case "cancelled":
			return ansi.dim;
	}
};

const capabilityColor = (): string => `${ansi.dim}${ansi.cyan}`;

const taskTitleLineColored = (
	task: {
		readonly id: string;
		readonly capability: Capability;
		readonly status: TaskStatus;
		readonly title: string;
		readonly unresolved_dependency_ids?: readonly string[];
	},
	enabled: boolean,
): string => {
	if (!enabled) return taskTitleLine(task);
	const status = effectiveTaskStatus(task);
	return `${color(enabled, taskStatusColor(task.status), task.id)} ${color(enabled, capabilityColor(), `[${task.capability}]`)} [${status}] ${task.title}`;
};

const fencedMarkdown = (body: string): string => {
	const longestBacktickRun = Math.max(
		0,
		...[...body.matchAll(/`+/g)].map((match) => match[0]?.length ?? 0),
	);
	const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
	return `${fence}md\n${body}\n${fence}`;
};

const renderArtifactMarkdown = (artifact: ArtifactOutput): string =>
	`Artifact ${artifact.id} [${artifact.kind}] ${artifact.title}:\n\n${fencedMarkdown(artifact.body)}`;

const renderExpandedTaskMarkdown = (
	task: TaskInspectTaskOutput,
	artifacts: readonly ArtifactOutput[],
): string => {
	const parts = [`### ${taskTitleLine(task)}`, `Body:\n\n${fencedMarkdown(task.body)}`];
	parts.push(...artifacts.map(renderArtifactMarkdown));
	return parts.join("\n\n");
};

const renderTaskBullet = (
	task: TaskDetailOutput,
	unresolvedDependencyIds: readonly string[] = [],
): string => `- ${taskTitleLine({ ...task, unresolved_dependency_ids: unresolvedDependencyIds })}`;

const sourceKindLabel = (kind: SourceKind): string =>
	kind === "chain_source" ? "continuation provenance" : "repair provenance";

const renderSourceBullet = (source: TaskSourceSummaryOutput | null): string =>
	source === null ? "- none" : `- ${sourceKindLabel(source.source_kind)}: ${taskTitleLine(source)}`;

export const renderTaskInspectMarkdown = (inspect: TaskInspectOutput): string => {
	const lineageTasks = new Map(inspect.lineage.map((entry) => [entry.task.id, entry.task]));
	const recentHistory = [...inspect.lineage]
		.sort(
			(left, right) =>
				left.depth - right.depth ||
				left.task.created_at.localeCompare(right.task.created_at) ||
				left.task.id.localeCompare(right.task.id),
		)
		.slice(0, 2)
		.sort(
			(left, right) =>
				right.depth - left.depth ||
				left.task.created_at.localeCompare(right.task.created_at) ||
				left.task.id.localeCompare(right.task.id),
		)
		.map((entry) => renderExpandedTaskMarkdown(entry.task, entry.artifacts));
	const currentParts = [
		renderExpandedTaskMarkdown(inspect.task, inspect.artifacts),
		"Depends on:",
		inspect.dependencies.length === 0
			? "- none"
			: inspect.dependencies
					.map((task) =>
						renderTaskBullet(task, lineageTasks.get(task.id)?.unresolved_dependency_ids),
					)
					.join("\n"),
		"Unlocks:",
		inspect.dependents.length === 0
			? "- none"
			: inspect.dependents
					.map((task) =>
						renderTaskBullet(task, inspect.task.status === "done" ? [] : [inspect.task.id]),
					)
					.join("\n"),
	];
	if (inspect.source !== null) {
		currentParts.push("Source link:", renderSourceBullet(inspect.source));
	}
	if (inspect.repair_alert_kind !== null) {
		currentParts.push(`Repair Alert kind: ${inspect.repair_alert_kind}`);
	}
	const sections = [`# ${taskTitleLine(inspect.task)}`];
	if (inspect.superseded_by !== null) {
		sections.push(`> ⚠️ This task has been superseded by ${inspect.superseded_by}`);
	}
	if (inspect.supersedes !== null) {
		sections.push(`> This task supersedes ${inspect.supersedes}`);
	}
	sections.push(
		"## Recent history",
		recentHistory.length === 0 ? "No upstream history." : recentHistory.join("\n\n"),
		"## Current task",
		currentParts.join("\n\n"),
	);
	return sections.join("\n\n") + "\n";
};

export const renderGraphInspectText = (
	{ graph }: GraphInspectOutput,
	options: { readonly color?: boolean } = {},
): string => {
	const colorEnabled = options.color ?? false;
	const byId = new Map(graph.nodes.map((node) => [node.id, node]));
	const childrenByParent = new Map<string, string[]>();
	const childIds = new Set<string>();
	for (const edge of graph.edges) {
		if (edge.kind !== "depends_on") continue;
		if (!byId.has(edge.from_task_id) || !byId.has(edge.to_task_id)) continue;
		childrenByParent.set(edge.to_task_id, [
			...(childrenByParent.get(edge.to_task_id) ?? []),
			edge.from_task_id,
		]);
		childIds.add(edge.from_task_id);
	}
	const successorBySuperseded = new Map<string, string>();
	const successorIds = new Set<string>();
	for (const edge of graph.edges) {
		if (edge.kind !== "supersedes") continue;
		if (!byId.has(edge.from_task_id) || !byId.has(edge.to_task_id)) continue;
		successorBySuperseded.set(edge.to_task_id, edge.from_task_id);
		successorIds.add(edge.from_task_id);
	}
	for (const [parentId, childIds] of childrenByParent.entries()) {
		childrenByParent.set(
			parentId,
			[...childIds].sort((left, right) => {
				const leftNode = byId.get(left);
				const rightNode = byId.get(right);
				if (leftNode === undefined || rightNode === undefined) return left.localeCompare(right);
				return leftNode.title.localeCompare(rightNode.title) || left.localeCompare(right);
			}),
		);
	}
	const lines: string[] = [];
	const written = new Set<string>();
	const writeNode = (id: string, depth: number, supersessionChild = false): void => {
		const node = byId.get(id);
		if (node === undefined) return;
		const prefix = supersessionChild ? "~> " : "- ";
		if (written.has(id)) {
			lines.push(`${"  ".repeat(depth)}${prefix}↑ ${id} already shown`);
			return;
		}
		lines.push(`${"  ".repeat(depth)}${prefix}${taskTitleLineColored(node, colorEnabled)}`);
		written.add(id);
		for (const childId of childrenByParent.get(id) ?? []) writeNode(childId, depth + 1);
		const successorId = successorBySuperseded.get(id);
		if (successorId !== undefined) writeNode(successorId, depth + 1, true);
	};
	for (const node of graph.nodes) {
		if (!childIds.has(node.id) && !successorIds.has(node.id)) writeNode(node.id, 0);
	}
	for (const node of graph.nodes) {
		if (!written.has(node.id)) writeNode(node.id, 0);
	}
	return `${lines.join("\n")}\n`;
};

const renderBriefingTaskBullet = (task: TaskSummaryOutput): string => {
	const descNote = task.scope_description ? ` (${task.scope_description})` : "";
	return `- ${taskTitleLine(task)}${descNote}`;
};

export const renderBriefingText = (briefing: BriefingOutput): string => {
	const lines = ["# Briefing", "", "## Ready"];
	lines.push(
		...(briefing.ready.length === 0 ? ["- none"] : briefing.ready.map(renderBriefingTaskBullet)),
	);
	lines.push("", "## Blocked");
	if (briefing.blocked.length === 0) {
		lines.push("- none");
	} else {
		for (const task of briefing.blocked) {
			lines.push(renderBriefingTaskBullet(task));
			for (const blocker of task.blockers) {
				const descNote = blocker.scope_description ? ` (${blocker.scope_description})` : "";
				lines.push(
					`  - blocked by ${blocker.id} [${blocker.status}] scope=${blocker.scope_id}${descNote}`,
				);
			}
		}
	}
	lines.push("", "## Recently Completed");
	lines.push(
		...(briefing.recentlyCompleted.length === 0
			? ["- none"]
			: briefing.recentlyCompleted.map(renderBriefingTaskBullet)),
	);
	return `${lines.join("\n")}\n`;
};
