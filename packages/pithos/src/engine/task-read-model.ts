import { Schema } from "effect";
import type { Db, EdgeKind, SourceKind, TaskStatus } from "../db.js";
import { sql } from "../db.js";
import { fail } from "../errors.js";
import {
	decodeRow,
	ScopeRowSchema,
	TaskEdgeRowSchema,
	TaskGateLateGrowthMarkerRowSchema,
	TaskRowSchema,
	type ScopeRow,
	type TaskEdgeRow,
	type TaskGateLateGrowthMarkerRow,
} from "../rows.js";
import type {
	ArtifactOutput,
	LineageEntryOutput,
	ScopeIdentityOutput,
	ScopeOutput,
	TaskDetailOutput,
	GateInspectOutput,
	TaskInspectTaskOutput,
	TaskSourceSummaryOutput,
	TaskSummaryOutput,
} from "./types.js";

export type TaskSummary = TaskSummaryOutput;

const TaskSummaryRowSchema = Schema.extend(
	TaskRowSchema,
	Schema.Struct({
		scope_kind: Schema.Literal("global", "repo", "worktree"),
		canonical_path: Schema.NullOr(Schema.String),
		parent_repo_path: Schema.NullOr(Schema.String),
		scope_description: Schema.NullOr(Schema.String),
		completed_at: Schema.NullOr(Schema.String),
	}),
);
type TaskSummaryRow = typeof TaskSummaryRowSchema.Type;

export const taskEdges = (db: Db): readonly TaskEdgeRow[] =>
	db
		.prepare(
			sql`SELECT task_id, target_task_id, kind, created_by_run_id, created_at FROM task_edges`,
		)
		.all()
		.map((row) => decodeRow(TaskEdgeRowSchema, row, "malformed task edge row"));

export const taskGateLateGrowthMarkers = (db: Db): readonly TaskGateLateGrowthMarkerRow[] =>
	db
		.prepare(sql`
			SELECT
				id,
				gate_task_id,
				gate_target_task_id,
				gate_attempt,
				mutation_kind,
				edge_task_id,
				edge_target_task_id,
				edge_kind,
				superseded_task_id,
				replacement_task_id,
				created_by_run_id,
				created_at
			FROM task_gate_late_growth_markers
			ORDER BY created_at ASC, id ASC
		`)
		.all()
		.map((row) =>
			decodeRow(TaskGateLateGrowthMarkerRowSchema, row, "malformed late-growth marker row"),
		);

const TaskEdgeTargetRowSchema = Schema.Struct({ id: Schema.String });

export const canonicalTaskId = (db: Db, taskId: string): string => {
	let current = taskId;
	const seen = new Set<string>();
	while (true) {
		if (seen.has(current)) fail("VALIDATION_ERROR", "task supersession cycle detected");
		seen.add(current);
		const next = db
			.prepare(sql`SELECT new_task_id FROM task_supersessions WHERE old_task_id = ?`)
			.pluck()
			.get(current) as string | undefined;
		if (next === undefined) return current;
		current = next;
	}
};

const taskStatus = (db: Db, taskId: string): TaskStatus =>
	(db
		.prepare(sql`SELECT status FROM tasks WHERE id = ?`)
		.pluck()
		.get(taskId) as TaskStatus | undefined) ?? fail("NOT_FOUND", `task not found: ${taskId}`);

export const unresolvedDependencies = (db: Db, taskId: string): readonly string[] =>
	db
		.prepare(sql`
			SELECT te.target_task_id AS id
			FROM task_edges te
			WHERE te.task_id = ?
			  AND te.kind = 'after'
			ORDER BY te.created_at ASC, te.target_task_id ASC
		`)
		.all(taskId)
		.map((row) => decodeRow(TaskEdgeTargetRowSchema, row, "malformed unresolved edge row").id)
		.filter((id) => taskStatus(db, canonicalTaskId(db, id)) !== "done");

export const branchClosure = (db: Db, anchorTaskId: string): GateInspectOutput["members"] => {
	const canonicalClosure = new Set<string>();
	const members = new Map<string, string>();
	const addMember = (taskId: string): boolean => {
		const canonicalId = canonicalTaskId(db, taskId);
		const beforeSize = canonicalClosure.size;
		canonicalClosure.add(canonicalId);
		members.set(taskId, canonicalId);
		return canonicalClosure.size !== beforeSize;
	};
	addMember(anchorTaskId);
	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of taskEdges(db).filter((row) => row.kind !== "gate")) {
			const canonicalTarget = canonicalTaskId(db, edge.target_task_id);
			if (!canonicalClosure.has(canonicalTarget)) continue;
			if (addMember(edge.task_id)) changed = true;
		}
	}
	return [...members.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([taskId, canonicalId]) => ({
			task_id: taskId,
			canonical_task_id: canonicalId,
			status: taskStatus(db, canonicalId),
		}));
};

export const gateStateForTarget = (db: Db, targetTaskId: string): GateInspectOutput => {
	const members = branchClosure(db, targetTaskId);
	const brokenStatuses = new Set(["failed", "cancelled", "dead_letter"]);
	return {
		target_task_id: targetTaskId,
		state: members.every((member) => member.status === "done")
			? "clear"
			: members.some((member) => brokenStatuses.has(member.status))
				? "broken"
				: "open",
		members,
	};
};

export const taskGates = (db: Db, taskId: string): readonly GateInspectOutput[] =>
	db
		.prepare(sql`
			SELECT target_task_id AS id
			FROM task_edges
			WHERE task_id = ?
			  AND kind = 'gate'
			ORDER BY created_at ASC, target_task_id ASC
		`)
		.all(taskId)
		.map((row) =>
			gateStateForTarget(db, decodeRow(TaskEdgeTargetRowSchema, row, "malformed gate edge row").id),
		);

export const taskSummarySelect = sql`
SELECT t.id, t.scope_id, s.kind AS scope_kind, s.canonical_path, s.parent_repo_path, s.description AS scope_description, t.capability, t.title, t.body, t.status, t.fencing_token, t.attempts, t.max_attempts, t.created_at, t.completed_at
FROM tasks t
JOIN scopes s ON s.id = t.scope_id
`;

const toTaskSummary = (row: TaskSummaryRow): TaskSummary => ({
	id: row.id,
	scope_id: row.scope_id,
	scope_kind: row.scope_kind,
	canonical_path: row.canonical_path,
	parent_repo_path: row.parent_repo_path,
	scope_description: row.scope_description,
	capability: row.capability,
	status: row.status,
	title: row.title,
	created_at: row.created_at,
	completed_at: row.completed_at,
});

export const parseTaskSummary = (value: unknown, message: string): TaskSummary =>
	toTaskSummary(decodeRow(TaskSummaryRowSchema, value, message));

export const parseTaskDetail = (value: unknown, message: string): TaskDetailOutput => {
	const row = decodeRow(TaskSummaryRowSchema, value, message);
	return {
		...toTaskSummary(row),
		body: row.body,
		fencing_token: row.fencing_token,
		attempts: row.attempts,
		max_attempts: row.max_attempts,
	};
};

const ScopeListRowSchema = Schema.extend(
	ScopeRowSchema,
	Schema.Struct({
		task_count: Schema.Number,
		run_count: Schema.Number,
	}),
);

const ScopeArchiveCheckRowSchema = Schema.extend(
	ScopeListRowSchema,
	Schema.Struct({
		live_run_count: Schema.Number,
		active_task_count: Schema.Number,
	}),
);

type ScopeListRow = typeof ScopeListRowSchema.Type;
type ScopeArchiveCheckRow = typeof ScopeArchiveCheckRowSchema.Type;

const toScopeIdentityOutput = (row: ScopeRow): ScopeIdentityOutput => ({
	id: row.id,
	kind: row.kind,
	canonical_path: row.canonical_path,
	parent_repo_path: row.parent_repo_path,
	archived_at: row.archived_at,
	description: row.description,
});

export const parseScopeIdentity = (value: unknown, message: string): ScopeIdentityOutput =>
	toScopeIdentityOutput(decodeRow(ScopeRowSchema, value, message));

export const toScopeOutput = (row: ScopeListRow): ScopeOutput => ({
	...toScopeIdentityOutput(row),
	task_count: row.task_count,
	run_count: row.run_count,
});

export const parseScopeOutput = (value: unknown, message: string): ScopeOutput =>
	toScopeOutput(decodeRow(ScopeListRowSchema, value, message));

export const parseScopeArchiveCheck = (value: unknown, message: string): ScopeArchiveCheckRow =>
	decodeRow(ScopeArchiveCheckRowSchema, value, message);

const ArtifactRowSchema = Schema.Struct({
	id: Schema.String,
	kind: Schema.String,
	title: Schema.String,
	body: Schema.String,
	created_at: Schema.String,
});

const parseArtifact = (value: unknown): ArtifactOutput =>
	decodeRow(ArtifactRowSchema, value, "malformed artifact row");

const TaskEdgeKindSchema = Schema.Literal("about", "repair");

const TaskSourceEdgeRowSchema = Schema.Struct({
	task_id: Schema.String,
	source_task_id: Schema.String,
	kind: TaskEdgeKindSchema,
});

type TaskSourceEdgeRow = typeof TaskSourceEdgeRowSchema.Type;

const parseTaskSourceEdge = (value: unknown): TaskSourceEdgeRow =>
	decodeRow(TaskSourceEdgeRowSchema, value, "malformed task edge row");

export const compareTaskCreatedAt = <
	T extends { readonly created_at: string; readonly id: string },
>(
	a: T,
	b: T,
): number => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

export const taskSummary = (db: Db, taskId: string): TaskSummary =>
	parseTaskSummary(
		db.prepare(`${taskSummarySelect} WHERE t.id = ?`).get(taskId),
		`task not found: ${taskId}`,
	);

export const taskDetail = (db: Db, taskId: string): TaskDetailOutput =>
	parseTaskDetail(
		db.prepare(`${taskSummarySelect} WHERE t.id = ?`).get(taskId),
		`task not found: ${taskId}`,
	);

export const taskArtifacts = (db: Db, taskId: string): readonly ArtifactOutput[] =>
	db
		.prepare(
			sql`SELECT id, kind, title, body, created_at FROM artifacts WHERE task_id=? ORDER BY created_at ASC, id ASC`,
		)
		.all(taskId)
		.map(parseArtifact);

export const taskSupersessionLinks = (
	db: Db,
	taskId: string,
): { readonly supersedes: string | null; readonly superseded_by: string | null } => ({
	supersedes:
		(db
			.prepare(sql`SELECT old_task_id FROM task_supersessions WHERE new_task_id=?`)
			.pluck()
			.get(taskId) as string | undefined) ?? null,
	superseded_by:
		(db
			.prepare(sql`SELECT new_task_id FROM task_supersessions WHERE old_task_id=?`)
			.pluck()
			.get(taskId) as string | undefined) ?? null,
});

export const taskSourceEdges = (db: Db): readonly TaskSourceEdgeRow[] =>
	taskEdges(db)
		.filter((edge) => edge.kind === "about" || edge.kind === "repair")
		.map((edge) =>
			parseTaskSourceEdge({
				task_id: edge.task_id,
				source_task_id: edge.target_task_id,
				kind: edge.kind,
			}),
		);

export const taskSourceEdge = (db: Db, taskId: string): TaskSourceEdgeRow | null => {
	const row = db
		.prepare(sql`
			SELECT task_id, target_task_id AS source_task_id, kind
			FROM task_edges
			WHERE task_id=? AND kind IN ('about', 'repair')
		`)
		.get(taskId);
	return row === undefined ? null : parseTaskSourceEdge(row);
};

export const taskSourceSummary = (db: Db, taskId: string): TaskSourceSummaryOutput | null => {
	const edge = taskSourceEdge(db, taskId);
	return edge === null ? null : { ...taskSummary(db, edge.source_task_id), source_kind: edge.kind };
};

export const taskAttachedContext = (db: Db, taskId: string): readonly TaskSourceSummaryOutput[] =>
	taskEdges(db)
		.filter(
			(edge) => edge.target_task_id === taskId && (edge.kind === "about" || edge.kind === "repair"),
		)
		.sort(
			(a, b) =>
				a.kind.localeCompare(b.kind) ||
				a.created_at.localeCompare(b.created_at) ||
				a.task_id.localeCompare(b.task_id),
		)
		.map((edge) => ({
			...taskSummary(db, edge.task_id),
			source_kind: edge.kind === "about" ? "about" : "repair",
		}));

export const validateReferenceTaskCurrent = (db: Db, taskId: string, label: string): void => {
	const exists = db.prepare(sql`SELECT 1 FROM tasks WHERE id = ?`).get(taskId);
	if (exists === undefined) fail("NOT_FOUND", `${label} task not found: ${taskId}`);
	const replacement = db
		.prepare(sql`SELECT new_task_id FROM task_supersessions WHERE old_task_id = ?`)
		.pluck()
		.get(taskId) as string | undefined;
	if (replacement !== undefined)
		fail("VALIDATION_ERROR", `${label} task ${taskId} was superseded by ${replacement}`);
};

export const insertTaskEdge = (
	db: Db,
	taskId: string,
	targetTaskId: string,
	createdByRunId: string,
	kind: EdgeKind,
): void => {
	const inserted = db
		.prepare(sql`
			INSERT INTO task_edges(task_id, target_task_id, kind, created_by_run_id)
			SELECT ?, t.id, ?, ?
			FROM tasks t
			WHERE t.id = ?
			  AND NOT EXISTS (
				SELECT 1 FROM task_supersessions ts WHERE ts.old_task_id = t.id
			  )
		`)
		.run(taskId, kind, createdByRunId, targetTaskId);
	if (inserted.changes === 1) return;
	validateReferenceTaskCurrent(db, targetTaskId, "edge target");
	fail("STALE_TOKEN_RACE", "target task changed before task edge write");
};

export const insertTaskSource = (
	db: Db,
	taskId: string,
	sourceTaskId: string,
	sourceRunId: string,
	kind: SourceKind,
): void =>
	insertTaskEdge(
		db,
		taskId,
		sourceTaskId,
		sourceRunId,
		kind === "chain_source" ? "about" : "repair",
	);

export const sortTaskIdsDeterministically = (
	db: Db,
	taskIds: readonly string[],
): readonly string[] =>
	taskIds
		.map((taskId) => taskSummary(db, taskId))
		.sort(compareTaskCreatedAt)
		.map((task) => task.id);

export const isClaimable = (
	db: Db,
	task: { readonly id: string; readonly status: string },
): boolean =>
	task.status === "queued" &&
	unresolvedDependencies(db, task.id).length === 0 &&
	taskGates(db, task.id).every((gate) => gate.state === "clear");

export const taskInspectTask = (db: Db, taskId: string): TaskInspectTaskOutput => {
	const task = taskDetail(db, taskId);
	return {
		...task,
		claimable: isClaimable(db, task),
		unresolved_dependency_ids: unresolvedDependencies(db, taskId),
		gates: taskGates(db, taskId),
	};
};

export const taskLineage = (db: Db, taskId: string): readonly LineageEntryOutput[] => {
	const parentsByTaskId = new Map<string, string[]>();
	for (const row of taskEdges(db)
		.filter((edge) => edge.kind === "after")
		.sort(
			(a, b) =>
				a.created_at.localeCompare(b.created_at) ||
				a.task_id.localeCompare(b.task_id) ||
				a.target_task_id.localeCompare(b.target_task_id),
		)) {
		parentsByTaskId.set(row.task_id, [
			...(parentsByTaskId.get(row.task_id) ?? []),
			row.target_task_id,
		]);
	}
	const lineage = new Map<string, { depth: number; via_task_ids: Set<string> }>();
	const queue: { readonly taskId: string; readonly depth: number }[] = [{ taskId, depth: 0 }];
	let index = 0;
	while (index < queue.length) {
		const current = queue[index] ?? fail("INTERNAL_ERROR", "missing lineage queue item");
		index += 1;
		for (const parentTaskId of parentsByTaskId.get(current.taskId) ?? []) {
			const depth = current.depth + 1;
			const existing = lineage.get(parentTaskId);
			if (existing === undefined || depth < existing.depth) {
				lineage.set(parentTaskId, { depth, via_task_ids: new Set([current.taskId]) });
				queue.push({ taskId: parentTaskId, depth });
				continue;
			}
			if (depth === existing.depth) {
				existing.via_task_ids.add(current.taskId);
			}
		}
	}
	return [...lineage.entries()]
		.map(([ancestorTaskId, state]) => {
			const task = taskInspectTask(db, ancestorTaskId);
			const supersession = taskSupersessionLinks(db, ancestorTaskId);
			return {
				depth: state.depth,
				via_task_ids: sortTaskIdsDeterministically(db, [...state.via_task_ids]),
				task,
				supersedes: supersession.supersedes,
				superseded_by: supersession.superseded_by,
				artifacts: taskArtifacts(db, ancestorTaskId),
			};
		})
		.sort((a, b) => b.depth - a.depth || compareTaskCreatedAt(a.task, b.task));
};
