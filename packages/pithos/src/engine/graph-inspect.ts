import type { Db } from "../db.js";
import { sql, type TaskStatus } from "../db.js";
import { fail } from "../errors.js";
import {
	isClaimable,
	taskSourceEdge,
	taskSourceEdges,
	taskSummary,
	unresolvedDependencies,
} from "./task-read-model.js";
import type { GraphInspectOutput, GraphSelectorOutput, GraphSinceCutoff } from "./types.js";

const requireNonEmpty = (value: string, name: string): string => {
	if (value.length === 0) fail("VALIDATION_ERROR", `${name} must be non-empty`);
	return value;
};

const statusFilterSql = (statuses: readonly TaskStatus[]): string =>
	statuses.length === 0 ? "" : ` AND status IN (${statuses.map(() => "?").join(",")})`;

const requireNonEmptySearchTerms = (search: readonly string[]): readonly string[] =>
	search.map((term) => requireNonEmpty(term.trim(), "--search"));

const searchFilterSql = (search: readonly string[]): string =>
	search
		.map(() => " AND (instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0)")
		.join("");

const searchFilterParams = (search: readonly string[]): readonly string[] =>
	search.flatMap((term) => [term, term]);

const sinceFilterSql = (since: GraphSinceCutoff | undefined): string =>
	since === undefined ? "" : " AND (created_at >= ? OR updated_at >= ? OR completed_at >= ?)";

const sinceFilterParams = (since: GraphSinceCutoff | undefined): readonly string[] =>
	since === undefined ? [] : [since.dbTimestamp, since.dbTimestamp, since.dbTimestamp];

const toDbTimestamp = (date: Date): string => {
	if (Number.isNaN(date.getTime())) fail("VALIDATION_ERROR", "invalid --since cutoff");
	return date
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d{3}Z$/, "");
};

const startOfLocalDay = (date: Date): Date =>
	new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);

export const parseGraphSinceCutoff = (raw: string, nowIso: string): GraphSinceCutoff => {
	const value = requireNonEmpty(raw.trim(), "--since");
	const now = new Date(nowIso);
	if (Number.isNaN(now.getTime())) {
		fail("INTERNAL_ERROR", `clock returned invalid ISO timestamp: ${nowIso}`);
	}
	if (value === "today") return { dbTimestamp: toDbTimestamp(startOfLocalDay(now)) };
	const relative = /^(\d+)([hd])$/.exec(value);
	if (relative !== null) {
		const amount = Number(relative[1]);
		if (!Number.isSafeInteger(amount) || amount < 1) {
			fail("VALIDATION_ERROR", "invalid --since cutoff");
		}
		const unit = relative[2];
		const millis = amount * (unit === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
		return { dbTimestamp: toDbTimestamp(new Date(now.getTime() - millis)) };
	}
	const localDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (localDate !== null) {
		const year = Number(localDate[1]);
		const month = Number(localDate[2]);
		const day = Number(localDate[3]);
		const cutoff = new Date(year, month - 1, day, 0, 0, 0, 0);
		if (
			cutoff.getFullYear() !== year ||
			cutoff.getMonth() !== month - 1 ||
			cutoff.getDate() !== day
		) {
			fail("VALIDATION_ERROR", "invalid --since cutoff");
		}
		return { dbTimestamp: toDbTimestamp(cutoff) };
	}
	const isoTimestamp =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
			value,
		);
	if (isoTimestamp !== null) {
		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime())) fail("VALIDATION_ERROR", "invalid --since cutoff");
		const offset = isoTimestamp[8] ?? fail("INTERNAL_ERROR", "missing ISO timestamp offset");
		const offsetMinutes =
			offset === "Z" ? 0 : Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6));
		const localInstant = new Date(
			parsed.getTime() + (offset.startsWith("-") ? -offsetMinutes : offsetMinutes) * 60_000,
		);
		const [year, month, day, hour, minute, second] = [
			localInstant.getUTCFullYear(),
			localInstant.getUTCMonth() + 1,
			localInstant.getUTCDate(),
			localInstant.getUTCHours(),
			localInstant.getUTCMinutes(),
			localInstant.getUTCSeconds(),
		];
		if (
			year !== Number(isoTimestamp[1]) ||
			month !== Number(isoTimestamp[2]) ||
			day !== Number(isoTimestamp[3]) ||
			hour !== Number(isoTimestamp[4]) ||
			minute !== Number(isoTimestamp[5]) ||
			second !== Number(isoTimestamp[6])
		) {
			fail("VALIDATION_ERROR", "invalid --since cutoff");
		}
		return { dbTimestamp: toDbTimestamp(parsed) };
	}
	return fail("VALIDATION_ERROR", "invalid --since cutoff");
};

const graphForIds = (
	db: Db,
	selector: GraphSelectorOutput,
	seedIds: readonly string[],
): GraphInspectOutput => {
	const ids = new Set(seedIds);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of db
			.prepare(sql`SELECT task_id, depends_on_task_id FROM task_dependencies`)
			.all() as { task_id: string; depends_on_task_id: string }[]) {
			if (ids.has(row.task_id) || ids.has(row.depends_on_task_id)) {
				if (!ids.has(row.task_id)) {
					ids.add(row.task_id);
					changed = true;
				}
				if (!ids.has(row.depends_on_task_id)) {
					ids.add(row.depends_on_task_id);
					changed = true;
				}
			}
		}
		for (const row of taskSourceEdges(db)) {
			if (row.kind === "repair_source" && selector.kind === "scope") {
				// For scope-based graphs, repair_source expansion is one-directional:
				// follow alert → affected task, but not the reverse. This prevents
				// global Repair Alert tasks from leaking into scoped (repo/worktree)
				// graph views just because a failed task in that scope is in the
				// seed set. For task-by-ID graphs the bidirectional path below is
				// intentional so the repair alert is visible when inspecting the
				// affected task directly.
				if (ids.has(row.task_id) && !ids.has(row.source_task_id)) {
					ids.add(row.source_task_id);
					changed = true;
				}
			} else if (ids.has(row.task_id) || ids.has(row.source_task_id)) {
				if (!ids.has(row.task_id)) {
					ids.add(row.task_id);
					changed = true;
				}
				if (!ids.has(row.source_task_id)) {
					ids.add(row.source_task_id);
					changed = true;
				}
			}
		}
		for (const row of db
			.prepare(sql`SELECT old_task_id, new_task_id FROM task_supersessions`)
			.all() as { old_task_id: string; new_task_id: string }[]) {
			if (ids.has(row.old_task_id) || ids.has(row.new_task_id)) {
				if (!ids.has(row.old_task_id)) {
					ids.add(row.old_task_id);
					changed = true;
				}
				if (!ids.has(row.new_task_id)) {
					ids.add(row.new_task_id);
					changed = true;
				}
			}
		}
	}
	const nodes = [...ids]
		.map((id) => taskSummary(db, id))
		.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
		.map((task) => ({
			id: task.id,
			scope_id: task.scope_id,
			scope_kind: task.scope_kind,
			canonical_path: task.canonical_path,
			parent_repo_path: task.parent_repo_path,
			scope_description: task.scope_description,
			capability: task.capability,
			status: task.status,
			title: task.title,
			created_at: task.created_at,
			completed_at: task.completed_at,
			claimable: isClaimable(db, task),
			unresolved_dependency_ids: unresolvedDependencies(db, task.id),
			supersedes_task_id:
				(db
					.prepare(sql`SELECT old_task_id FROM task_supersessions WHERE new_task_id=?`)
					.pluck()
					.get(task.id) as string | undefined) ?? null,
			superseded_by_task_id:
				(db
					.prepare(sql`SELECT new_task_id FROM task_supersessions WHERE old_task_id=?`)
					.pluck()
					.get(task.id) as string | undefined) ?? null,
			source_task_id: taskSourceEdge(db, task.id)?.source_task_id ?? null,
			source_kind: taskSourceEdge(db, task.id)?.kind ?? null,
		}));
	const edges = [
		...(
			db.prepare(sql`SELECT task_id, depends_on_task_id FROM task_dependencies`).all() as {
				task_id: string;
				depends_on_task_id: string;
			}[]
		)
			.filter((e) => ids.has(e.task_id) && ids.has(e.depends_on_task_id))
			.map((e) => ({
				kind: "depends_on" as const,
				from_task_id: e.task_id,
				to_task_id: e.depends_on_task_id,
				satisfied:
					(db
						.prepare(sql`SELECT status FROM tasks WHERE id=?`)
						.pluck()
						.get(e.depends_on_task_id) as string) === "done",
			})),
		...taskSourceEdges(db)
			.filter((e) => ids.has(e.task_id) && ids.has(e.source_task_id))
			.map((e) => ({
				kind: "source" as const,
				from_task_id: e.task_id,
				to_task_id: e.source_task_id,
				source_kind: e.kind,
			})),
		...(
			db.prepare(sql`SELECT old_task_id, new_task_id FROM task_supersessions`).all() as {
				old_task_id: string;
				new_task_id: string;
			}[]
		)
			.filter((e) => ids.has(e.old_task_id) && ids.has(e.new_task_id))
			.map((e) => ({
				kind: "supersedes" as const,
				from_task_id: e.new_task_id,
				to_task_id: e.old_task_id,
			})),
	].sort(
		(a, b) =>
			a.kind.localeCompare(b.kind) ||
			a.from_task_id.localeCompare(b.from_task_id) ||
			a.to_task_id.localeCompare(b.to_task_id),
	);
	return { ok: true as const, graph: { selector, nodes, edges } };
};

export const inspectGraph = (
	db: Db,
	input: {
		readonly taskId: string | undefined;
		readonly scope: string | undefined;
		readonly all: boolean | undefined;
		readonly status?: readonly TaskStatus[];
		readonly search?: readonly string[];
		readonly sinceCutoff: GraphSinceCutoff | undefined;
	},
): GraphInspectOutput => {
	const { taskId, scope, all, sinceCutoff } = input;
	const status = input.status ?? [];
	const searchTerms = requireNonEmptySearchTerms(input.search ?? []);
	const selectorCount = [taskId, scope, all === true ? "all" : undefined].filter(
		(v) => v !== undefined,
	).length;
	if (selectorCount !== 1) fail("VALIDATION_ERROR", "provide exactly one graph selector");

	const defaultVisibility =
		status.length === 0 && searchTerms.length === 0 && sinceCutoff === undefined
			? " AND (status <> 'cancelled' OR completed_at > datetime('now', '-1 hour'))"
			: "";
	const statusClause = statusFilterSql(status);
	const searchClause = searchFilterSql(searchTerms);
	const sinceClause = sinceFilterSql(sinceCutoff);
	const filterParams = [
		...status,
		...searchFilterParams(searchTerms),
		...sinceFilterParams(sinceCutoff),
	];

	if (taskId !== undefined) {
		taskSummary(db, taskId);
		return graphForIds(
			db,
			{ kind: "task", value: taskId },
			(
				db
					.prepare(sql`
						SELECT id
						FROM tasks
						WHERE id=?
						  ${statusClause}
						  ${searchClause}
						  ${sinceClause}
					`)
					.all(taskId, ...filterParams) as { id: string }[]
			).map((r) => r.id),
		);
	}

	if (scope !== undefined) {
		const scopeExists = db.prepare(sql`SELECT 1 FROM scopes WHERE id=?`).get(scope);
		if (scopeExists === undefined) fail("NOT_FOUND", `scope not found: ${scope}`);
		return graphForIds(
			db,
			{ kind: "scope", value: scope },
			(
				db
					.prepare(sql`
						SELECT id
						FROM tasks
						WHERE scope_id=?
						  ${defaultVisibility}
						  ${statusClause}
						  ${searchClause}
						  ${sinceClause}
					`)
					.all(scope, ...filterParams) as { id: string }[]
			).map((r) => r.id),
		);
	}

	return graphForIds(
		db,
		{ kind: "all" },
		(
			db
				.prepare(sql`
					SELECT id
					FROM tasks
					WHERE 1=1
					  ${defaultVisibility}
					  ${statusClause}
					  ${searchClause}
					  ${sinceClause}
				`)
				.all(...filterParams) as { id: string }[]
		).map((r) => r.id),
	);
};
