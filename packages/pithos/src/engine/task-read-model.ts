import { Schema } from "effect";
import type { Db, SourceKind } from "../db.js";
import { sql } from "../db.js";
import { fail } from "../errors.js";
import { decodeRow, ScopeRowSchema, TaskRowSchema, type ScopeRow } from "../rows.js";
import type {
	ArtifactOutput,
	LineageEntryOutput,
	ScopeIdentityOutput,
	ScopeOutput,
	TaskDetailOutput,
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

export const unresolvedDependencies = (db: Db, taskId: string): readonly string[] =>
	(
		db
			.prepare(sql`
			SELECT td.depends_on_task_id AS id
			FROM task_dependencies td
			JOIN tasks dep ON dep.id = td.depends_on_task_id
			WHERE td.task_id = ?
			  AND dep.status <> 'done'
			ORDER BY td.created_at ASC, td.depends_on_task_id ASC
		`)
			.all(taskId) as { readonly id: string }[]
	).map((r) => r.id);

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

const SourceKindSchema = Schema.Literal("chain_source", "repair_source");

const TaskSourceEdgeRowSchema = Schema.Struct({
	task_id: Schema.String,
	source_task_id: Schema.String,
	kind: SourceKindSchema,
});

type TaskSourceEdgeRow = typeof TaskSourceEdgeRowSchema.Type;

const parseTaskSourceEdge = (value: unknown): TaskSourceEdgeRow =>
	decodeRow(TaskSourceEdgeRowSchema, value, "malformed task source edge row");

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
	db
		.prepare(sql`SELECT task_id, source_task_id, kind FROM task_sources`)
		.all()
		.map(parseTaskSourceEdge);

export const taskSourceEdge = (db: Db, taskId: string): TaskSourceEdgeRow | null => {
	const row = db
		.prepare(sql`SELECT task_id, source_task_id, kind FROM task_sources WHERE task_id=?`)
		.get(taskId);
	return row === undefined ? null : parseTaskSourceEdge(row);
};

export const taskSourceSummary = (db: Db, taskId: string): TaskSourceSummaryOutput | null => {
	const edge = taskSourceEdge(db, taskId);
	return edge === null ? null : { ...taskSummary(db, edge.source_task_id), source_kind: edge.kind };
};

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

export const insertTaskSource = (
	db: Db,
	taskId: string,
	sourceTaskId: string,
	sourceRunId: string,
	kind: SourceKind,
): void => {
	const inserted = db
		.prepare(sql`
			INSERT INTO task_sources(task_id, source_task_id, source_run_id, kind)
			SELECT ?, t.id, ?, ?
			FROM tasks t
			WHERE t.id = ?
			  AND NOT EXISTS (
				SELECT 1 FROM task_supersessions ts WHERE ts.old_task_id = t.id
			  )
		`)
		.run(taskId, sourceRunId, kind, sourceTaskId);
	if (inserted.changes === 1) return;
	validateReferenceTaskCurrent(db, sourceTaskId, "source");
	fail("STALE_TOKEN_RACE", "source task changed before source link write");
};

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
): boolean => task.status === "queued" && unresolvedDependencies(db, task.id).length === 0;

export const taskInspectTask = (db: Db, taskId: string): TaskInspectTaskOutput => {
	const task = taskDetail(db, taskId);
	return {
		...task,
		claimable: isClaimable(db, task),
		unresolved_dependency_ids: unresolvedDependencies(db, taskId),
	};
};

export const taskLineage = (db: Db, taskId: string): readonly LineageEntryOutput[] => {
	const parentsByTaskId = new Map<string, string[]>();
	for (const row of db
		.prepare(
			sql`SELECT task_id, depends_on_task_id FROM task_dependencies ORDER BY created_at ASC, task_id ASC, depends_on_task_id ASC`,
		)
		.all() as {
		readonly task_id: string;
		readonly depends_on_task_id: string;
	}[]) {
		parentsByTaskId.set(row.task_id, [
			...(parentsByTaskId.get(row.task_id) ?? []),
			row.depends_on_task_id,
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
