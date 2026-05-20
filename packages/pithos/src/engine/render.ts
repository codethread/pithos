import type { Capability, TaskStatus } from "../db.js";
import type {
	ArtifactOutput,
	BriefingOutput,
	GateInspectOutput,
	GraphInspectOutput,
	LateGrowthMarkerOutput,
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

const displayScopePath = (canonicalPath: string, homeDir: string | undefined): string => {
	if (homeDir === undefined) return canonicalPath;
	const normalizedHome = homeDir.replace(/\/+$/, "");
	if (canonicalPath === normalizedHome) return "~";
	return canonicalPath.startsWith(`${normalizedHome}/`)
		? `~/${canonicalPath.slice(normalizedHome.length + 1)}`
		: canonicalPath;
};

const graphTaskTitleLine = (
	task: {
		readonly id: string;
		readonly capability: Capability;
		readonly status: TaskStatus;
		readonly title: string;
		readonly canonical_path: string | null;
		readonly unresolved_dependency_ids?: readonly string[];
	},
	homeDir: string | undefined,
): string => {
	const scopeNote =
		task.canonical_path === null ? "" : ` (${displayScopePath(task.canonical_path, homeDir)})`;
	return `${task.id} [${task.capability}] [${effectiveTaskStatus(task)}]${scopeNote} ${task.title}`;
};

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

const graphTaskTitleLineColored = (
	task: {
		readonly id: string;
		readonly capability: Capability;
		readonly status: TaskStatus;
		readonly title: string;
		readonly canonical_path: string | null;
		readonly unresolved_dependency_ids?: readonly string[];
	},
	enabled: boolean,
	homeDir: string | undefined,
): string => {
	if (!enabled) return graphTaskTitleLine(task, homeDir);
	const status = effectiveTaskStatus(task);
	const scopeNote =
		task.canonical_path === null ? "" : ` (${displayScopePath(task.canonical_path, homeDir)})`;
	return `${color(enabled, taskStatusColor(task.status), task.id)} ${color(enabled, capabilityColor(), `[${task.capability}]`)} [${status}]${scopeNote} ${task.title}`;
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

const sourceKindLabel = (kind: "about" | "repair"): string =>
	kind === "about" ? "about" : "repair";

const renderSourceBullet = (source: TaskSourceSummaryOutput | null): string =>
	source === null
		? "- none"
		: `- ${sourceKindLabel(source.source_kind)} source: ${taskTitleLine(source)}`;

const renderAttachedContextBullet = (task: TaskSourceSummaryOutput): string =>
	`- ${sourceKindLabel(task.source_kind)} attached: ${taskTitleLine(task)}`;

const brokenStatuses = new Set<TaskStatus>(["failed", "cancelled", "dead_letter"]);

const gateRelevantMembers = (
	gate: Pick<GateInspectOutput, "state" | "members">,
): GateInspectOutput["members"] =>
	gate.state === "clear"
		? []
		: gate.members.filter((member) =>
				gate.state === "broken" ? brokenStatuses.has(member.status) : member.status !== "done",
			);

const renderGateMarkdown = (gate: GateInspectOutput): string => {
	const lines = [`- ${gate.target_task_id} [${gate.state}]`];
	const members = gateRelevantMembers(gate);
	if (members.length > 0) {
		lines.push(`  ${gate.state === "broken" ? "Broken" : "Open"} branch members:`);
		for (const member of members) {
			const canonicalNote =
				member.canonical_task_id === member.task_id ? "" : ` canonical=${member.canonical_task_id}`;
			lines.push(`  - ${member.task_id} [${member.status}]${canonicalNote}`);
		}
	}
	return lines.join("\n");
};

const renderLateGrowthMarker = (marker: LateGrowthMarkerOutput): string =>
	marker.mutation_kind === "edge_inserted"
		? `- ${marker.id}: allowed late ${marker.edge_kind} edge ${marker.edge_task_id} -> ${marker.edge_target_task_id} after gate ${marker.gate_task_id} -> ${marker.gate_target_task_id} attempt ${marker.gate_attempt}`
		: `- ${marker.id}: allowed late supersession ${marker.replacement_task_id} supersedes ${marker.superseded_task_id} after gate ${marker.gate_task_id} -> ${marker.gate_target_task_id} attempt ${marker.gate_attempt}`;

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
		"Direct after dependencies:",
		inspect.dependencies.length === 0
			? "- none"
			: inspect.dependencies
					.map((task) =>
						renderTaskBullet(task, lineageTasks.get(task.id)?.unresolved_dependency_ids),
					)
					.join("\n"),
		"Direct after dependents:",
		inspect.dependents.length === 0
			? "- none"
			: inspect.dependents
					.map((task) =>
						renderTaskBullet(task, inspect.task.status === "done" ? [] : [inspect.task.id]),
					)
					.join("\n"),
	];
	currentParts.push(
		"Coordination gates:",
		inspect.task.gates.length === 0
			? "- none"
			: inspect.task.gates.map(renderGateMarkdown).join("\n"),
	);
	currentParts.push(
		"Attached context:",
		[
			...(inspect.source === null ? [] : [renderSourceBullet(inspect.source)]),
			...inspect.attached_context.map(renderAttachedContextBullet),
		].join("\n") || "- none",
	);
	if (inspect.repair_alert_kind !== null) {
		currentParts.push(`Repair Alert kind: ${inspect.repair_alert_kind}`);
	}
	if (inspect.late_growth_markers.length > 0) {
		currentParts.push(
			"Allowed late branch growth:",
			inspect.late_growth_markers.map(renderLateGrowthMarker).join("\n"),
		);
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
	options: { readonly color?: boolean; readonly homeDir?: string | undefined } = {},
): string => {
	const colorEnabled = options.color ?? false;
	const homeDir = options.homeDir;
	const byId = new Map(graph.nodes.map((node) => [node.id, node]));
	const childrenByParent = new Map<string, string[]>();
	const childIds = new Set<string>();
	const contextByTarget = new Map<
		string,
		{ readonly taskId: string; readonly kind: "about" | "repair" }[]
	>();
	const gatesByTarget = new Map<
		string,
		{
			readonly taskId: string;
			readonly state: "clear" | "open" | "broken";
			readonly members: GateInspectOutput["members"];
		}[]
	>();
	for (const edge of graph.edges) {
		if (edge.kind === "after") {
			if (!byId.has(edge.from_task_id) || !byId.has(edge.to_task_id)) continue;
			childrenByParent.set(edge.to_task_id, [
				...(childrenByParent.get(edge.to_task_id) ?? []),
				edge.from_task_id,
			]);
			childIds.add(edge.from_task_id);
			continue;
		}
		if (edge.kind === "about" || edge.kind === "repair") {
			if (!byId.has(edge.from_task_id) || !byId.has(edge.to_task_id)) continue;
			contextByTarget.set(edge.to_task_id, [
				...(contextByTarget.get(edge.to_task_id) ?? []),
				{ taskId: edge.from_task_id, kind: edge.kind },
			]);
			childIds.add(edge.from_task_id);
			continue;
		}
		if (edge.kind === "gate") {
			if (!byId.has(edge.from_task_id) || !byId.has(edge.to_task_id)) continue;
			gatesByTarget.set(edge.to_task_id, [
				...(gatesByTarget.get(edge.to_task_id) ?? []),
				{ taskId: edge.from_task_id, state: edge.state, members: edge.members },
			]);
			childIds.add(edge.from_task_id);
		}
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
	const writeNode = (
		id: string,
		depth: number,
		supersessionChild = false,
		label: string | undefined = undefined,
	): void => {
		const node = byId.get(id);
		if (node === undefined) return;
		const prefix = supersessionChild ? "~> " : `- ${label === undefined ? "" : `${label} `}`;
		if (written.has(id)) {
			lines.push(`${"  ".repeat(depth)}${prefix}↑ ${id} already shown`);
			return;
		}
		lines.push(
			`${"  ".repeat(depth)}${prefix}${graphTaskTitleLineColored(node, colorEnabled, homeDir)}`,
		);
		written.add(id);
		for (const context of contextByTarget.get(id) ?? []) {
			writeNode(context.taskId, depth + 1, false, context.kind);
		}
		for (const gate of gatesByTarget.get(id) ?? []) {
			writeNode(gate.taskId, depth + 1, false, `gate [${gate.state}]`);
			for (const member of gateRelevantMembers(gate)) {
				lines.push(`${"  ".repeat(depth + 2)}- ${member.task_id} [${member.status}]`);
			}
		}
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
	for (const marker of graph.late_growth_markers) {
		if (lines.length === 0 || lines[lines.length - 1] !== "Allowed late branch growth:") {
			lines.push("Allowed late branch growth:");
		}
		lines.push(renderLateGrowthMarker(marker));
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
					`  - after blocker ${blocker.id} [${blocker.status}] scope=${blocker.scope_id}${descNote}`,
				);
			}
			for (const gate of task.gates) {
				lines.push(`  - gate ${gate.target_task_id} [${gate.state}]`);
				for (const member of gateRelevantMembers(gate)) {
					lines.push(`    - branch member ${member.task_id} [${member.status}]`);
				}
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
