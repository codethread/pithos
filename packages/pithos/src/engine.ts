import { Effect, Either, ParseResult, Schema } from "effect";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import {
	migrate,
	openDb,
	sql,
	type Capability,
	type HarnessKind,
	type Mode,
	type ScopeKind,
	type TaskStatus,
} from "./db.js";
import { fail } from "./errors.js";
import {
	decodeRow,
	EventRowSchema,
	RunRowSchema,
	ScopeRowSchema,
	TaskRowSchema,
	type RunRow,
} from "./rows.js";
import type { Services } from "./services.js";

export interface EngineContext {
	readonly config: Config;
	readonly services: Services;
}

export interface Engine {
	readonly init: (input: { readonly fresh: boolean }) => { readonly ok: true };
	readonly scopeUpsert: (input: {
		readonly kind: ScopeKind;
		readonly path: string | undefined;
	}) => {
		readonly ok: true;
		readonly scope: {
			readonly id: string;
			readonly kind: ScopeKind;
			readonly canonical_path: string | null;
		};
	};
	readonly runUpsert: (input: {
		readonly agent: string;
		readonly mode: Mode;
		readonly scope: string;
		readonly cwd: string;
		readonly harnessKind: HarnessKind;
		readonly sessionLogPath: string;
		readonly sessionId: string;
		readonly runId: string | undefined;
	}) => { readonly ok: true; readonly run: RunOutput };
	readonly runInspect: (input: { readonly runId: string }) => {
		readonly ok: true;
		readonly run: RunOutput;
	};
	readonly activeRunForTask: (input: { readonly taskId: string }) => {
		readonly ok: true;
		readonly run: RunOutput | null;
	};
	readonly runCleanup: (input: { readonly runId: string; readonly reason: string }) => {
		readonly ok: true;
		readonly run: RunOutput;
	};
	readonly runInterrupt: (input: {
		readonly runId: string | undefined;
		readonly taskId: string | undefined;
		readonly reason: string;
		readonly expectedRunId?: string;
	}) => {
		readonly ok: true;
		readonly run: RunOutput;
		readonly interrupted_task: { readonly id: string; readonly scope_id: string } | null;
	};
	readonly runTimeout: (input: { readonly runId: string; readonly reason: string }) => {
		readonly ok: true;
		readonly run: RunOutput;
	};
	readonly eventsTail: (input: { readonly limit: number | undefined }) => {
		readonly ok: true;
		readonly events: readonly EventOutput[];
	};
	readonly enqueue: (input: {
		readonly scope: string;
		readonly capability: Capability;
		readonly title: string;
		readonly body: string | undefined;
		readonly bodyFile: string | undefined;
		readonly runId: string | undefined;
		readonly dependsOn: readonly string[];
	}) => { readonly ok: true; readonly task: { readonly id: string; readonly status: "queued" } };
	readonly claim: (input: {
		readonly runId: string | undefined;
		readonly scope: string;
		readonly capability: Capability;
	}) => {
		readonly ok: true;
		readonly task: { readonly id: string; readonly status: "claimed"; readonly token: number };
	};
	readonly heartbeat: (input: {
		readonly runId: string | undefined;
		readonly taskId: string | undefined;
		readonly token: number | undefined;
	}) => { readonly ok: true; readonly status: string };
	readonly complete: (input: {
		readonly taskId: string;
		readonly runId: string | undefined;
		readonly token: number;
		readonly resultFile: string | undefined;
	}) => { readonly ok: true; readonly task: { readonly id: string; readonly status: "done" } };
	readonly failTask: (input: {
		readonly taskId: string;
		readonly runId: string | undefined;
		readonly token: number;
		readonly reason: string;
	}) => { readonly ok: true; readonly task: { readonly id: string; readonly status: "failed" } };
	readonly artifactAdd: (input: {
		readonly taskId: string;
		readonly runId: string | undefined;
		readonly kind: string;
		readonly title: string;
		readonly body: string;
	}) => { readonly ok: true; readonly artifact: { readonly id: string } };
	readonly taskInspect: (input: { readonly taskId: string }) => TaskInspectOutput;
	readonly cancel: (input: {
		readonly taskId: string;
		readonly runId: string | undefined;
		readonly reason: string;
	}) => { readonly ok: true; readonly task: { readonly id: string; readonly status: "cancelled" } };
	readonly graphInspect: (input: {
		readonly taskId: string | undefined;
		readonly scope: string | undefined;
		readonly all: boolean;
		readonly flat: boolean;
		readonly dump: boolean;
	}) => GraphInspectOutput | string;
	readonly briefing: (input: { readonly agent: string | undefined }) => BriefingOutput;
	readonly supersede: (input: {
		readonly taskId: string;
		readonly runId: string | undefined;
		readonly reason: string;
		readonly title: string | undefined;
		readonly body: string | undefined;
		readonly bodyFile: string | undefined;
		readonly scope: string | undefined;
		readonly capability: Capability | undefined;
	}) => SupersedeOutput;
}

export type Json =
	| null
	| boolean
	| number
	| string
	| readonly Json[]
	| { readonly [key: string]: Json };

export interface TaskSummaryOutput {
	readonly id: string;
	readonly scope_id: string;
	readonly scope_kind: ScopeKind;
	readonly canonical_path: string | null;
	readonly capability: Capability;
	readonly status: TaskStatus;
	readonly title: string;
	readonly created_at: string;
}

export interface TaskDetailOutput extends TaskSummaryOutput {
	readonly body: string;
	readonly fencing_token: number;
	readonly attempts: number;
	readonly max_attempts: number;
}

export interface TaskInspectOutput {
	readonly ok: true;
	readonly task: TaskSummaryOutput & {
		readonly claimable: boolean;
		readonly unresolved_dependency_ids: readonly string[];
	};
	readonly dependencies: readonly TaskDetailOutput[];
	readonly dependents: readonly TaskDetailOutput[];
	readonly supersedes: string | null;
	readonly superseded_by: string | null;
	readonly artifacts: readonly ArtifactOutput[];
}

export interface ArtifactOutput {
	readonly id: string;
	readonly kind: string;
	readonly title: string;
	readonly body: string;
	readonly created_at: string;
}

export type GraphSelectorOutput =
	| { readonly kind: "task"; readonly value: string }
	| { readonly kind: "scope"; readonly value: string }
	| { readonly kind: "all" };

export interface GraphNodeOutput extends TaskSummaryOutput {
	readonly claimable: boolean;
	readonly unresolved_dependency_ids: readonly string[];
	readonly supersedes_task_id: string | null;
	readonly superseded_by_task_id: string | null;
}

export type GraphEdgeOutput =
	| {
			readonly kind: "depends_on";
			readonly from_task_id: string;
			readonly to_task_id: string;
			readonly satisfied: boolean;
	  }
	| {
			readonly kind: "supersedes";
			readonly from_task_id: string;
			readonly to_task_id: string;
	  };

export interface GraphInspectOutput {
	readonly ok: true;
	readonly graph: {
		readonly selector: GraphSelectorOutput;
		readonly nodes: readonly GraphNodeOutput[];
		readonly edges: readonly GraphEdgeOutput[];
	};
}

export interface BlockerOutput {
	readonly id: string;
	readonly scope_id: string;
	readonly status: TaskStatus;
}

export interface BlockedTaskOutput extends TaskSummaryOutput {
	readonly unresolved_dependency_ids: readonly string[];
	readonly blockers: readonly BlockerOutput[];
}

export interface BriefingOutput {
	readonly ok: true;
	readonly ready: readonly TaskSummaryOutput[];
	readonly blocked: readonly BlockedTaskOutput[];
}

export interface SupersedeOutput {
	readonly ok: true;
	readonly task: {
		readonly id: string;
		readonly status: "queued";
		readonly scope_id: string;
		readonly capability: Capability;
	};
	readonly supersession: {
		readonly old_task_id: string;
		readonly new_task_id: string;
		readonly retargeted_dependent_task_ids: readonly string[];
	};
}

export interface RunOutput {
	readonly id: string;
	readonly agent: string;
	readonly mode: Mode;
	readonly scope_id: string;
	readonly status: string;
	readonly task_id: string | null;
	readonly session_id: string;
	readonly harness_kind: HarnessKind;
	readonly session_log_path: string;
	readonly created_at: string;
	readonly updated_at: string;
}

export interface EventOutput {
	readonly id: string;
	readonly type: string;
	readonly task_id: string | null;
	readonly run_id: string | null;
	readonly actor_run_id: string | null;
	readonly payload: Json;
	readonly created_at: string;
}

const toRunOutput = (row: RunRow): RunOutput => ({
	id: row.id,
	agent: row.agent_kind,
	mode: row.mode,
	scope_id: row.scope_id,
	status: row.status,
	task_id: row.task_id,
	session_id: row.session_id,
	harness_kind: row.harness_kind,
	session_log_path: row.session_log_path,
	created_at: row.created_at,
	updated_at: row.updated_at,
});

const eventPayload = sql`
INSERT INTO events(
	id, type, task_id, run_id, actor_run_id, payload_json
) VALUES (
	?,?,?,?,?,?
)
`;

const claimableTaskQuery = sql`
SELECT id
FROM tasks t
WHERE t.status = 'queued'
  AND t.scope_id = ?
  AND t.capability = ?
  AND NOT EXISTS (
	SELECT 1
	FROM task_dependencies td
	JOIN tasks dep ON dep.id = td.depends_on_task_id
	WHERE td.task_id = t.id
	  AND dep.status <> 'done'
  )
ORDER BY t.created_at ASC, t.id ASC
LIMIT 1
`;

const claimRunTaskUpdate = sql`
UPDATE runs
SET task_id = ?,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ?
  AND task_id IS NULL
`;

const claimTaskUpdate = sql`
UPDATE tasks
SET status = 'claimed',
    attempts = attempts + 1,
    fencing_token = fencing_token + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ?
  AND status = 'queued'
RETURNING id, fencing_token
`;

const HarnessKindSchema = Schema.Literal("claude", "pi", "system");

const parseHarnessKind = (value: unknown): HarnessKind =>
	Either.match(Schema.decodeUnknownEither(HarnessKindSchema)(value), {
		onLeft: () =>
			fail(
				"VALIDATION_ERROR",
				`invalid --harness-kind: ${String(value)}. Valid values: claude, pi, system`,
			),
		onRight: (kind) => kind,
	});

const requireNonEmpty = (value: string, name: string): string => {
	if (value.length === 0) fail("VALIDATION_ERROR", `${name} must be non-empty`);
	return value;
};

const resolveRunId = (ctx: EngineContext, explicit: string | undefined): string => {
	const env = ctx.config.runId;
	if (explicit !== undefined && env !== undefined && explicit !== env) {
		fail("VALIDATION_ERROR", "--run conflicts with PITHOS_RUN_ID");
	}
	return requireNonEmpty(explicit ?? env ?? fail("VALIDATION_ERROR", "missing --run"), "--run");
};

const resolveBody = (
	ctx: EngineContext,
	body: string | undefined,
	bodyFile: string | undefined,
): string => {
	if (body !== undefined && bodyFile !== undefined) {
		fail("VALIDATION_ERROR", "provide only one of --body or --body-file");
	}
	const value =
		body ??
		(bodyFile === undefined ? undefined : Effect.runSync(ctx.services.fs.readText(bodyFile)));
	return requireNonEmpty(
		value ?? fail("VALIDATION_ERROR", "missing --body or --body-file"),
		"body",
	);
};

const upsertScope = sql`
INSERT INTO scopes(
	id,
	kind,
	canonical_path
) VALUES (?, ?, ?)
ON CONFLICT(id)
DO UPDATE SET
	kind = excluded.kind,
	canonical_path = excluded.canonical_path,
	updated_at = CURRENT_TIMESTAMP
`;

const upsertRun = sql`
INSERT INTO runs(
	id,
	agent_kind,
	mode,
	scope_id,
	cwd,
	session_id,
	harness_kind,
	session_log_path
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id)
DO UPDATE SET
	agent_kind = excluded.agent_kind,
	mode = excluded.mode,
	scope_id = excluded.scope_id,
	cwd = excluded.cwd,
	session_id = excluded.session_id,
	harness_kind = excluded.harness_kind,
	session_log_path = excluded.session_log_path,
	updated_at = CURRENT_TIMESTAMP
`;

const runSelect = sql`
SELECT
	id,
	agent_kind,
	mode,
	scope_id,
	cwd,
	harness_kind,
	session_log_path,
	status,
	task_id,
	session_id,
	created_at,
	updated_at
FROM runs
`;

const event = (
	ctx: EngineContext,
	db: Db,
	type: string,
	payload: { task_id?: string; run_id?: string; actor_run_id?: string; payload: Json },
): void => {
	db.prepare(eventPayload).run(
		Effect.runSync(ctx.services.ids.make("event")),
		type,
		payload.task_id ?? null,
		payload.run_id ?? null,
		payload.actor_run_id ?? null,
		JSON.stringify(payload.payload),
	);
};

const withDb = <A>(ctx: EngineContext, f: (db: Db) => A): A => {
	const db = openDb(ctx.config.dbPath);
	migrate(db);
	try {
		return f(db);
	} finally {
		db.close();
	}
};

const EventPayloadSchema = Schema.parseJson(Schema.Unknown);

const decodeEventPayload = (payloadJson: string, eventId: string): Json => {
	const decoded = Schema.decodeUnknownEither(EventPayloadSchema)(payloadJson);
	return Either.match(decoded, {
		onLeft: (error) =>
			fail(
				"INTERNAL_ERROR",
				`malformed event payload_json for ${eventId}: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
			),
		onRight: (payload) => payload as Json,
	});
};

const liveRun = (db: Db, runId: string): RunRow => {
	const r = decodeRow(
		RunRowSchema,
		db.prepare(`${runSelect} WHERE id=?`).get(runId),
		`run not found: ${runId}`,
	);
	if (r.status !== "live") fail("VALIDATION_ERROR", `run is not live: ${runId}`);
	return r;
};

const authorized = (
	db: Db,
	table: "agent_claims" | "agent_enqueues",
	runId: string,
	cap: Capability,
): RunRow => {
	const r = liveRun(db, runId);

	const tableName = table === "agent_claims" ? "agent_claims" : "agent_enqueues";
	const isAuthorized = db
		.prepare(
			sql`
			SELECT 1
			FROM ${tableName}
			WHERE agent_kind = ?
			  AND capability = ?
			`,
		)
		.get(r.agent_kind, cap);
	if (isAuthorized === undefined)
		fail("VALIDATION_ERROR", `${r.agent_kind} is not authorized for ${cap}`);

	return r;
};

export type TaskSummary = TaskSummaryOutput;

const TaskSummaryRowSchema = Schema.extend(
	TaskRowSchema,
	Schema.Struct({
		scope_kind: Schema.Literal("global", "repo", "worktree"),
		canonical_path: Schema.NullOr(Schema.String),
	}),
);
type TaskSummaryRow = typeof TaskSummaryRowSchema.Type;

const unresolvedDependencies = (db: Db, taskId: string): readonly string[] =>
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

const taskSummarySelect = sql`
SELECT t.id, t.scope_id, s.kind AS scope_kind, s.canonical_path, t.capability, t.title, t.body, t.status, t.fencing_token, t.attempts, t.max_attempts, t.created_at
FROM tasks t
JOIN scopes s ON s.id = t.scope_id
`;

const toTaskSummary = (row: TaskSummaryRow): TaskSummary => ({
	id: row.id,
	scope_id: row.scope_id,
	scope_kind: row.scope_kind,
	canonical_path: row.canonical_path,
	capability: row.capability,
	status: row.status,
	title: row.title,
	created_at: row.created_at,
});

const parseTaskSummary = (value: unknown, message: string): TaskSummary =>
	toTaskSummary(decodeRow(TaskSummaryRowSchema, value, message));

const parseTaskDetail = (value: unknown, message: string): TaskDetailOutput => {
	const row = decodeRow(TaskSummaryRowSchema, value, message);
	return {
		...toTaskSummary(row),
		body: row.body,
		fencing_token: row.fencing_token,
		attempts: row.attempts,
		max_attempts: row.max_attempts,
	};
};

const ArtifactRowSchema = Schema.Struct({
	id: Schema.String,
	kind: Schema.String,
	title: Schema.String,
	body: Schema.String,
	created_at: Schema.String,
});

const parseArtifact = (value: unknown): ArtifactOutput =>
	decodeRow(ArtifactRowSchema, value, "malformed artifact row");

const taskSummary = (db: Db, taskId: string): TaskSummary =>
	parseTaskSummary(
		db.prepare(`${taskSummarySelect} WHERE t.id = ?`).get(taskId),
		`task not found: ${taskId}`,
	);

const isClaimable = (db: Db, task: { readonly id: string; readonly status: string }): boolean =>
	task.status === "queued" && unresolvedDependencies(db, task.id).length === 0;

const runById = (db: Db, runId: string): RunRow =>
	decodeRow(
		RunRowSchema,
		db.prepare(`${runSelect} WHERE id=?`).get(runId),
		`run not found: ${runId}`,
	);

const terminalRunStatuses = ["ended", "failed", "cancelled", "timed_out"] as const;
const activeTaskStatuses = ["claimed", "running"] as const;
const terminalTaskStatuses = ["done", "failed", "dead_letter", "cancelled"] as const;

const runTerminalStatusForTask = (taskStatus: string): "ended" | "failed" =>
	taskStatus === "done" ? "ended" : "failed";

const assertAcyclic = (db: Db): void => {
	const edges = db
		.prepare(sql`SELECT task_id, depends_on_task_id FROM task_dependencies`)
		.all() as {
		readonly task_id: string;
		readonly depends_on_task_id: string;
	}[];
	const outgoing = new Map<string, string[]>();
	for (const edge of edges) {
		outgoing.set(edge.task_id, [...(outgoing.get(edge.task_id) ?? []), edge.depends_on_task_id]);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) fail("VALIDATION_ERROR", "task dependency cycle detected");
		if (visited.has(id)) return;
		visiting.add(id);
		for (const next of outgoing.get(id) ?? []) visit(next);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of outgoing.keys()) visit(id);
};

const renderFlatGraph = (
	graph: {
		readonly nodes: readonly {
			readonly id: string;
			readonly title: string;
			readonly status: string;
			readonly supersedes_task_id: string | null;
			readonly superseded_by_task_id: string | null;
		}[];
	},
	dump: boolean,
): string => {
	const byId = new Map(graph.nodes.map((node) => [node.id, node]));
	const replacementIds = new Set(
		graph.nodes.map((node) => node.superseded_by_task_id).filter((id): id is string => id !== null),
	);
	const roots = graph.nodes.filter(
		(node) => node.supersedes_task_id === null || !byId.has(node.supersedes_task_id),
	);
	const lines: string[] = [];
	const writeChain = (node: (typeof graph.nodes)[number], depth: number): void => {
		lines.push(`${"  ".repeat(depth)}- ${node.id} [${node.status}] ${node.title}`);
		const replacement =
			node.superseded_by_task_id === null ? undefined : byId.get(node.superseded_by_task_id);
		if (replacement !== undefined) writeChain(replacement, depth + 1);
	};
	for (const root of roots) {
		const chain = graph.nodes.filter((node) => {
			let current: typeof node | undefined = node;
			while (current !== undefined) {
				if (current.id === root.id) return true;
				current =
					current.supersedes_task_id === null ? undefined : byId.get(current.supersedes_task_id);
			}
			return false;
		});
		if (!dump && chain.every((node) => node.status === "done" || node.status === "cancelled"))
			continue;
		writeChain(root, 0);
	}
	for (const node of graph.nodes) {
		if (node.supersedes_task_id !== null || replacementIds.has(node.id) || roots.includes(node))
			continue;
		if (!dump && (node.status === "done" || node.status === "cancelled")) continue;
		lines.push(`- ${node.id} [${node.status}] ${node.title}`);
	}
	return `${lines.join("\n")}\n`;
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
			capability: task.capability,
			status: task.status,
			title: task.title,
			created_at: task.created_at,
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

export const makeEngine = (ctx: EngineContext): Engine => ({
	init: ({ fresh }) => {
		if (fresh) Effect.runSync(ctx.services.fs.removeFile(ctx.config.dbPath));
		const db = openDb(ctx.config.dbPath);
		try {
			migrate(db);
		} finally {
			db.close();
		}
		return { ok: true };
	},
	scopeUpsert: ({ kind, path }) =>
		withDb(ctx, (db) => {
			if (!(["global", "repo", "worktree"] as const).includes(kind)) {
				fail("VALIDATION_ERROR", `invalid scope kind: ${kind}`);
			}

			const rawPath =
				kind === "global"
					? undefined
					: requireNonEmpty(path ?? fail("VALIDATION_ERROR", "missing --path"), "--path");
			const canonical = rawPath === undefined ? null : resolve(rawPath);
			const sid = kind === "global" ? "global" : `${kind}:${canonical}`;

			db.prepare(upsertScope).run(sid, kind, canonical);
			return { ok: true, scope: { id: sid, kind, canonical_path: canonical } };
		}),
	runUpsert: ({ agent, mode, scope, cwd, harnessKind, sessionLogPath, sessionId, runId }) =>
		withDb(ctx, (db) => {
			const agentExists = db
				.prepare(sql`SELECT 1 FROM agent_kinds WHERE agent_kind = ?`)
				.get(agent);
			if (agentExists === undefined) fail("VALIDATION_ERROR", `unknown agent kind: ${agent}`);

			const scopeExists = db.prepare(sql`SELECT 1 FROM scopes WHERE id = ?`).get(scope);
			if (scopeExists === undefined) fail("NOT_FOUND", `scope not found: ${scope}`);

			const rid = requireNonEmpty(runId ?? Effect.runSync(ctx.services.ids.make("run")), "--run");
			db.prepare(upsertRun).run(
				rid,
				agent,
				mode,
				scope,
				requireNonEmpty(cwd, "--cwd"),
				requireNonEmpty(sessionId, "--session-id"),
				parseHarnessKind(harnessKind),
				requireNonEmpty(sessionLogPath, "--session-log-path"),
			);
			const row = decodeRow(
				RunRowSchema,
				db.prepare(`${runSelect} WHERE id=?`).get(rid),
				`run not found after upsert: ${rid}`,
			);
			return { ok: true, run: toRunOutput(row) };
		}),
	runInspect: ({ runId }) =>
		withDb(ctx, (db) => ({ ok: true, run: toRunOutput(runById(db, runId)) })),
	activeRunForTask: ({ taskId }) =>
		withDb(ctx, (db) => {
			const run = db
				.prepare(
					sql`SELECT * FROM runs WHERE task_id=? AND status NOT IN ('ended','failed','cancelled','timed_out')`,
				)
				.get(taskId);
			return {
				ok: true,
				run: run === undefined ? null : toRunOutput(decodeRow(RunRowSchema, run, "active run")),
			};
		}),
	runCleanup: ({ runId, reason }) =>
		withDb(ctx, (db) => {
			const nonEmptyReason = requireNonEmpty(reason, "--reason");
			const finalRun: RunRow = db.transaction((): RunRow => {
				const run = runById(db, runId);
				if (terminalRunStatuses.includes(run.status as (typeof terminalRunStatuses)[number])) {
					return run;
				}
				if (run.task_id === null) {
					const runUpdate = db
						.prepare(
							sql`UPDATE runs SET status='ended', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=? AND task_id IS NULL`,
						)
						.run(run.id, run.status);
					if (runUpdate.changes === 0)
						fail("STALE_TOKEN_RACE", "cleanup run snapshot changed before update");
					event(ctx, db, "run.cleanup", {
						run_id: run.id,
						payload: { reason: nonEmptyReason, previous_status: run.status, status: "ended" },
					});
					return runById(db, run.id);
				}
				const task = decodeRow(
					TaskRowSchema,
					db.prepare(`${taskSummarySelect} WHERE t.id=?`).get(run.task_id),
					`task not found: ${run.task_id}`,
				);
				if (terminalTaskStatuses.includes(task.status as (typeof terminalTaskStatuses)[number])) {
					const status = runTerminalStatusForTask(task.status);
					const runUpdate = db
						.prepare(
							sql`UPDATE runs SET status=?, task_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=? AND task_id=?`,
						)
						.run(status, run.id, run.status, task.id);
					if (runUpdate.changes === 0)
						fail("STALE_TOKEN_RACE", "cleanup run snapshot changed before update");
					event(ctx, db, "run.cleanup", {
						run_id: run.id,
						payload: {
							reason: nonEmptyReason,
							previous_status: run.status,
							status,
							task_id: task.id,
						},
					});
					return runById(db, run.id);
				}
				if (!activeTaskStatuses.includes(task.status as (typeof activeTaskStatuses)[number])) {
					fail("INTERNAL_ERROR", `unsupported held task status: ${task.status}`);
				}
				const nextTaskStatus = task.attempts < task.max_attempts ? "queued" : "dead_letter";
				const taskUpdate = db
					.prepare(
						sql`
						UPDATE tasks
						SET status=?, fencing_token=fencing_token + 1, updated_at=CURRENT_TIMESTAMP
						WHERE id=? AND status=? AND fencing_token=?
					`,
					)
					.run(nextTaskStatus, task.id, task.status, task.fencing_token);
				if (taskUpdate.changes === 0)
					fail("STALE_TOKEN_RACE", "cleanup active task snapshot changed before update");
				const runUpdate = db
					.prepare(
						sql`UPDATE runs SET status='failed', task_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=? AND task_id=?`,
					)
					.run(run.id, run.status, task.id);
				if (runUpdate.changes === 0)
					fail("STALE_TOKEN_RACE", "cleanup run snapshot changed before update");
				const taskEventType = nextTaskStatus === "queued" ? "task.reclaimed" : "task.dead_lettered";
				event(ctx, db, taskEventType, {
					task_id: task.id,
					run_id: run.id,
					payload: {
						previous_run_id: run.id,
						reason: nonEmptyReason,
						attempts: task.attempts,
						max_attempts: task.max_attempts,
						previous_fencing_token: task.fencing_token,
						new_fencing_token: task.fencing_token + 1,
					},
				});
				event(ctx, db, "run.cleanup", {
					run_id: run.id,
					payload: {
						reason: nonEmptyReason,
						previous_status: run.status,
						status: "failed",
						task_id: task.id,
					},
				});
				return runById(db, run.id);
			})();
			return { ok: true, run: toRunOutput(finalRun) };
		}),
	runInterrupt: ({ runId, taskId, reason, expectedRunId }) =>
		withDb(ctx, (db) => {
			const nonEmptyReason = requireNonEmpty(reason, "--reason");
			if ((runId === undefined) === (taskId === undefined)) {
				fail("VALIDATION_ERROR", "provide exactly one of --run or --task");
			}
			const result = db.transaction(
				(): {
					readonly run: RunRow;
					readonly interruptedTask: { readonly id: string; readonly scope_id: string } | null;
				} => {
					const resolvedRunId =
						runId ??
						(db
							.prepare(
								sql`SELECT id FROM runs WHERE task_id=? AND status NOT IN ('ended','failed','cancelled','timed_out')`,
							)
							.pluck()
							.get(taskId) as string | undefined) ??
						fail("NOT_FOUND", `no active run holds task: ${taskId}`);
					if (expectedRunId !== undefined && resolvedRunId !== expectedRunId) {
						fail("STALE_TOKEN_RACE", "interrupt task owner changed before supervisor kill");
					}
					const run = runById(db, resolvedRunId);
					if (taskId !== undefined && run.task_id !== taskId) {
						fail("STALE_TOKEN_RACE", "interrupt task owner changed before update");
					}
					if (terminalRunStatuses.includes(run.status as (typeof terminalRunStatuses)[number])) {
						return { run, interruptedTask: null };
					}
					if (run.task_id === null) {
						const runUpdate = db
							.prepare(
								sql`UPDATE runs SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=? AND task_id IS NULL`,
							)
							.run(run.id, run.status);
						if (runUpdate.changes === 0)
							fail("STALE_TOKEN_RACE", "interrupt run snapshot changed before update");
						event(ctx, db, "run.interrupted", {
							run_id: run.id,
							payload: { reason: nonEmptyReason, previous_status: run.status, status: "cancelled" },
						});
						return { run: runById(db, run.id), interruptedTask: null };
					}
					const task = decodeRow(
						TaskRowSchema,
						db.prepare(`${taskSummarySelect} WHERE t.id=?`).get(run.task_id),
						`task not found: ${run.task_id}`,
					);
					if (activeTaskStatuses.includes(task.status as (typeof activeTaskStatuses)[number])) {
						const taskUpdate = db
							.prepare(
								sql`
							UPDATE tasks
							SET status='failed', fencing_token=fencing_token + 1, updated_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP, result_json=?
							WHERE id=? AND status=? AND fencing_token=?
						`,
							)
							.run(
								JSON.stringify({ reason: nonEmptyReason }),
								task.id,
								task.status,
								task.fencing_token,
							);
						if (taskUpdate.changes === 0)
							fail("STALE_TOKEN_RACE", "interrupt active task snapshot changed before update");
						const runUpdate = db
							.prepare(
								sql`UPDATE runs SET status='failed', task_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=? AND task_id=?`,
							)
							.run(run.id, run.status, task.id);
						if (runUpdate.changes === 0)
							fail("STALE_TOKEN_RACE", "interrupt run snapshot changed before update");
						event(ctx, db, "task.interrupted", {
							task_id: task.id,
							run_id: run.id,
							payload: {
								run_id: run.id,
								reason: nonEmptyReason,
								previous_status: task.status,
								previous_fencing_token: task.fencing_token,
								new_fencing_token: task.fencing_token + 1,
							},
						});
						event(ctx, db, "run.interrupted", {
							run_id: run.id,
							payload: {
								reason: nonEmptyReason,
								previous_status: run.status,
								status: "failed",
								task_id: task.id,
							},
						});
						return {
							run: runById(db, run.id),
							interruptedTask: { id: task.id, scope_id: task.scope_id },
						};
					}
					if (terminalTaskStatuses.includes(task.status as (typeof terminalTaskStatuses)[number])) {
						const status = runTerminalStatusForTask(task.status);
						const runUpdate = db
							.prepare(
								sql`UPDATE runs SET status=?, task_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=? AND task_id=?`,
							)
							.run(status, run.id, run.status, task.id);
						if (runUpdate.changes === 0)
							fail("STALE_TOKEN_RACE", "interrupt run snapshot changed before update");
						event(ctx, db, "run.interrupted", {
							run_id: run.id,
							payload: {
								reason: nonEmptyReason,
								previous_status: run.status,
								status,
								task_id: task.id,
							},
						});
						return { run: runById(db, run.id), interruptedTask: null };
					}
					return fail("INTERNAL_ERROR", `unsupported held task status: ${task.status}`);
				},
			)();
			return {
				ok: true,
				run: toRunOutput(result.run),
				interrupted_task: result.interruptedTask,
			};
		}),
	runTimeout: ({ runId, reason }) =>
		withDb(ctx, (db) => {
			const nonEmptyReason = requireNonEmpty(reason, "--reason");
			const finalRun: RunRow = db.transaction((): RunRow => {
				const run = runById(db, runId);
				if (run.task_id !== null) fail("VALIDATION_ERROR", "run timeout requires no held task");
				if (terminalRunStatuses.includes(run.status as (typeof terminalRunStatuses)[number])) {
					return run;
				}
				if (run.agent_kind === "pandora" || run.agent_kind === "pdx") {
					fail("VALIDATION_ERROR", `run timeout is not valid for ${run.agent_kind}`);
				}
				const hasClaimed = db
					.prepare(sql`SELECT 1 FROM events WHERE type='task.claimed' AND actor_run_id=?`)
					.get(run.id);
				if (hasClaimed !== undefined) {
					fail("VALIDATION_ERROR", "run timeout requires a run that has never claimed a task");
				}
				const runUpdate = db
					.prepare(
						sql`UPDATE runs SET status='timed_out', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=? AND task_id IS NULL`,
					)
					.run(run.id, run.status);
				if (runUpdate.changes === 0)
					fail("STALE_TOKEN_RACE", "timeout run snapshot changed before update");
				event(ctx, db, "run.timed_out", {
					run_id: run.id,
					payload: { reason: nonEmptyReason, previous_status: run.status, status: "timed_out" },
				});
				return runById(db, run.id);
			})();
			return { ok: true, run: toRunOutput(finalRun) };
		}),
	eventsTail: ({ limit }) =>
		withDb(ctx, (db) => {
			if (limit !== undefined && limit < 1) fail("VALIDATION_ERROR", "--limit must be positive");
			const rows = db
				.prepare(
					sql`
					SELECT id,type,task_id,run_id,actor_run_id,payload_json,created_at
					FROM events
					ORDER BY created_at DESC, id DESC
					LIMIT ?
					`,
				)
				.all(limit ?? 100)
				.map((row) => decodeRow(EventRowSchema, row, "malformed event row"));
			return {
				ok: true,
				events: rows.reverse().map((row) => ({
					id: row.id,
					type: row.type,
					task_id: row.task_id,
					run_id: row.run_id,
					actor_run_id: row.actor_run_id,
					payload: decodeEventPayload(row.payload_json, row.id),
					created_at: row.created_at,
				})),
			};
		}),
	enqueue: ({ scope, capability, title, body, bodyFile, runId, dependsOn }) =>
		withDb(ctx, (db) => {
			const actorRunId = resolveRunId(ctx, runId);
			authorized(db, "agent_enqueues", actorRunId, capability);
			enforceCapScope(db, scope, capability);
			const uniqueDepends = new Set(dependsOn);
			if (uniqueDepends.size !== dependsOn.length) {
				fail("VALIDATION_ERROR", "duplicate --depends-on task id");
			}
			const taskBody = resolveBody(ctx, body, bodyFile);
			const taskTitle = requireNonEmpty(title, "--title");
			const taskId = Effect.runSync(ctx.services.ids.make("task"));

			db.transaction(() => {
				for (const depId of dependsOn) {
					const dep = db.prepare(sql`SELECT 1 FROM tasks WHERE id = ?`).get(depId);
					if (dep === undefined) fail("NOT_FOUND", `dependency task not found: ${depId}`);
					const replacement = db
						.prepare(sql`SELECT new_task_id FROM task_supersessions WHERE old_task_id = ?`)
						.pluck()
						.get(depId) as string | undefined;
					if (replacement !== undefined)
						fail("VALIDATION_ERROR", `dependency task ${depId} was superseded by ${replacement}`);
				}
				db.prepare(
					sql`INSERT INTO tasks(id,scope_id,capability,title,body,created_by_run_id) VALUES (?,?,?,?,?,?)`,
				).run(taskId, scope, capability, taskTitle, taskBody, actorRunId);
				for (const depId of dependsOn) {
					db.prepare(
						sql`INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES (?,?)`,
					).run(taskId, depId);
				}
				assertAcyclic(db);
				event(ctx, db, "task.created", {
					task_id: taskId,
					actor_run_id: actorRunId,
					payload: {
						scope_id: scope,
						capability,
						title: taskTitle,
						depends_on_task_ids: dependsOn,
					},
				});
			})();
			return { ok: true, task: { id: taskId, status: "queued" } };
		}),
	claim: ({ runId, scope, capability }) =>
		withDb(ctx, (db) => {
			const actorRunId = resolveRunId(ctx, runId);
			enforceCapScope(db, scope, capability);
			const r = authorized(db, "agent_claims", actorRunId, capability);
			if (r.scope_id !== scope)
				fail("VALIDATION_ERROR", `claim scope ${scope} does not match run scope ${r.scope_id}`);

			const claimed = db.transaction(() => {
				const currentRun = liveRun(db, actorRunId);
				if (currentRun.task_id !== null) fail("VALIDATION_ERROR", "run already holds a task");

				const candidate = db.prepare(claimableTaskQuery).get(scope, capability) as
					| { id: string }
					| undefined;
				const task = candidate ?? fail("NO_CLAIMABLE_WORK", "no claimable work");

				const runRow = db.prepare(claimRunTaskUpdate).run(task.id, actorRunId);
				if (runRow.changes === 0) fail("VALIDATION_ERROR", "run already holds a task");

				const updated = db.prepare(claimTaskUpdate).get(task.id) as
					| { id: string; fencing_token: number }
					| undefined;

				const claimedTask =
					updated ?? fail("STALE_TOKEN_RACE", "claim candidate changed before update");
				event(ctx, db, "task.claimed", {
					task_id: claimedTask.id,
					actor_run_id: actorRunId,
					payload: { run_id: actorRunId, fencing_token: claimedTask.fencing_token },
				});
				return claimedTask;
			})();

			return {
				ok: true,
				task: { id: claimed.id, status: "claimed", token: claimed.fencing_token },
			};
		}),
	heartbeat: ({ runId, taskId, token }) =>
		withDb(ctx, (db) => {
			const actorRunId = resolveRunId(ctx, runId);
			if ((taskId === undefined) !== (token === undefined)) {
				fail("VALIDATION_ERROR", "--task and --token must be supplied together");
			}
			const run = liveRun(db, actorRunId);
			if (taskId === undefined) {
				event(ctx, db, "run.heartbeat", { run_id: actorRunId, payload: { status: run.status } });
				return { ok: true, status: run.status };
			}
			const heartbeatToken = token ?? fail("VALIDATION_ERROR", "missing --token");
			db.transaction(() => {
				const previous = db
					.prepare(sql`
					SELECT status
					FROM tasks
					WHERE id = ?
					  AND fencing_token = ?
					  AND status IN ('claimed','running')
					  AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND task_id = tasks.id)
				`)
					.get(taskId, heartbeatToken, actorRunId) as { status: string } | undefined;
				const previousRow =
					previous ?? fail("STALE_TOKEN", "heartbeat token is stale or task is not held by run");
				const previousStatus = previousRow.status;
				db.prepare(sql`
					UPDATE tasks
					SET status = CASE status WHEN 'claimed' THEN 'running' ELSE status END,
					    updated_at = CURRENT_TIMESTAMP
					WHERE id = ?
				`).run(taskId);
				event(ctx, db, "task.heartbeat", {
					task_id: taskId,
					actor_run_id: actorRunId,
					payload: {
						run_id: actorRunId,
						fencing_token: heartbeatToken,
						previous_status: previousStatus,
						status: "running",
					},
				});
			})();
			return { ok: true, status: "running" };
		}),
	complete: ({ taskId, runId, token, resultFile }) =>
		withDb(ctx, (db) => {
			const actorRunId = resolveRunId(ctx, runId);
			liveRun(db, actorRunId);
			const resultJson =
				resultFile === undefined ? "{}" : Effect.runSync(ctx.services.fs.readText(resultFile));
			db.transaction(() => {
				const result = db
					.prepare(sql`
					UPDATE tasks
					SET status='done', result_json=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
					WHERE id=? AND fencing_token=? AND status IN ('claimed','running')
					  AND EXISTS (SELECT 1 FROM runs WHERE id=? AND task_id=tasks.id)
				`)
					.run(resultJson, taskId, token, actorRunId);
				if (result.changes === 0)
					fail("STALE_TOKEN", "complete token is stale or task is not held by run");
				db.prepare(
					sql`UPDATE runs SET task_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND task_id=?`,
				).run(actorRunId, taskId);
				event(ctx, db, "task.completed", {
					task_id: taskId,
					actor_run_id: actorRunId,
					payload: { run_id: actorRunId, fencing_token: token },
				});
			})();
			return { ok: true, task: { id: taskId, status: "done" } };
		}),
	failTask: ({ taskId, runId, token, reason }) =>
		withDb(ctx, (db) => {
			const actorRunId = resolveRunId(ctx, runId);
			liveRun(db, actorRunId);
			const nonEmptyReason = requireNonEmpty(reason, "--reason");
			db.transaction(() => {
				const result = db
					.prepare(sql`
					UPDATE tasks
					SET status='failed', result_json=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
					WHERE id=? AND fencing_token=? AND status IN ('claimed','running')
					  AND EXISTS (SELECT 1 FROM runs WHERE id=? AND task_id=tasks.id)
				`)
					.run(JSON.stringify({ reason: nonEmptyReason }), taskId, token, actorRunId);
				if (result.changes === 0)
					fail("STALE_TOKEN", "fail token is stale or task is not held by run");
				db.prepare(
					sql`UPDATE runs SET task_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND task_id=?`,
				).run(actorRunId, taskId);
				event(ctx, db, "task.failed", {
					task_id: taskId,
					actor_run_id: actorRunId,
					payload: { run_id: actorRunId, fencing_token: token, reason: nonEmptyReason },
				});
			})();
			return { ok: true, task: { id: taskId, status: "failed" } };
		}),
	artifactAdd: ({ taskId, runId, kind, title, body }) =>
		withDb(ctx, (db) => {
			const actorRunId = resolveRunId(ctx, runId);
			const task = db.prepare(sql`SELECT 1 FROM tasks WHERE id=?`).get(taskId);
			if (task === undefined) fail("NOT_FOUND", `task not found: ${taskId}`);
			liveRun(db, actorRunId);
			const artifactId = Effect.runSync(ctx.services.ids.make("artifact"));
			db.transaction(() => {
				db.prepare(
					sql`INSERT INTO artifacts(id,task_id,run_id,kind,title,body) VALUES (?,?,?,?,?,?)`,
				).run(
					artifactId,
					taskId,
					actorRunId,
					requireNonEmpty(kind, "--kind"),
					requireNonEmpty(title, "--title"),
					requireNonEmpty(body, "stdin body"),
				);
				event(ctx, db, "task.artifact_added", {
					task_id: taskId,
					actor_run_id: actorRunId,
					payload: { artifact_id: artifactId, kind },
				});
			})();
			return { ok: true, artifact: { id: artifactId } };
		}),
	cancel: ({ taskId, runId, reason }) =>
		withDb(ctx, (db) => {
			const actorRunId = resolveRunId(ctx, runId);
			liveRun(db, actorRunId);
			const nonEmptyReason = requireNonEmpty(reason, "--reason");
			db.transaction(() => {
				const task = taskSummary(db, taskId);
				if (["claimed", "running"].includes(task.status)) {
					fail(
						"VALIDATION_ERROR",
						`task ${taskId} is ${task.status}; use pdx kill or pithos run interrupt for held tasks`,
					);
				}
				if (!["queued", "failed", "dead_letter"].includes(task.status)) {
					fail("VALIDATION_ERROR", `task status cannot be cancelled: ${task.status}`);
				}
				const result = db
					.prepare(
						sql`UPDATE tasks SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?`,
					)
					.run(taskId, task.status);
				if (result.changes === 0) fail("STALE_TOKEN_RACE", "task changed before cancel");
				event(ctx, db, "task.cancelled", {
					task_id: taskId,
					actor_run_id: actorRunId,
					payload: { reason: nonEmptyReason },
				});
			})();
			return { ok: true, task: { id: taskId, status: "cancelled" } };
		}),
	taskInspect: ({ taskId }) =>
		withDb(ctx, (db) => {
			const task = taskSummary(db, taskId);
			const dependencies = db
				.prepare(
					`${taskSummarySelect} WHERE t.id IN (SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?) ORDER BY t.created_at ASC, t.id ASC`,
				)
				.all(taskId)
				.map((row) => parseTaskDetail(row, "malformed dependency task row"));
			const dependents = db
				.prepare(
					`${taskSummarySelect} WHERE t.id IN (SELECT task_id FROM task_dependencies WHERE depends_on_task_id=?) ORDER BY t.created_at ASC, t.id ASC`,
				)
				.all(taskId)
				.map((row) => parseTaskDetail(row, "malformed dependent task row"));
			const artifacts = db
				.prepare(
					sql`SELECT id, kind, title, body, created_at FROM artifacts WHERE task_id=? ORDER BY created_at ASC, id ASC`,
				)
				.all(taskId)
				.map(parseArtifact);
			return {
				ok: true,
				task: {
					...task,
					claimable: isClaimable(db, task),
					unresolved_dependency_ids: unresolvedDependencies(db, taskId),
				},
				dependencies,
				dependents,
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
				artifacts,
			};
		}),
	graphInspect: ({ taskId, scope, all, flat, dump }) =>
		withDb(ctx, (db) => {
			const selectorCount = [taskId, scope, all === true ? "all" : undefined].filter(
				(v) => v !== undefined,
			).length;
			if (selectorCount !== 1) fail("VALIDATION_ERROR", "provide exactly one graph selector");
			if (taskId !== undefined) {
				const result = graphForIds(db, { kind: "task", value: taskId }, [
					taskSummary(db, taskId).id,
				]);
				return flat ? renderFlatGraph(result.graph, dump) : result;
			}
			if (scope !== undefined) {
				const scopeExists = db.prepare(sql`SELECT 1 FROM scopes WHERE id=?`).get(scope);
				if (scopeExists === undefined) fail("NOT_FOUND", `scope not found: ${scope}`);
				const result = graphForIds(
					db,
					{ kind: "scope", value: scope },
					(
						db
							.prepare(sql`SELECT id FROM tasks WHERE scope_id=? AND status <> 'cancelled'`)
							.all(scope) as { id: string }[]
					).map((r) => r.id),
				);
				return flat ? renderFlatGraph(result.graph, dump) : result;
			}
			const result = graphForIds(
				db,
				{ kind: "all" },
				(
					db.prepare(sql`SELECT id FROM tasks WHERE status <> 'cancelled'`).all() as {
						id: string;
					}[]
				).map((r) => r.id),
			);
			return flat ? renderFlatGraph(result.graph, dump) : result;
		}),
	briefing: ({ agent }) =>
		withDb(ctx, (db) => {
			const caps =
				agent === undefined
					? undefined
					: (
							db
								.prepare(sql`SELECT capability FROM agent_claims WHERE agent_kind=?`)
								.all(agent) as { capability: string }[]
						).map((r) => r.capability);
			if (agent !== undefined && caps?.length === 0)
				fail("VALIDATION_ERROR", `unknown or unclaiming agent: ${agent}`);
			const queued = db
				.prepare(`${taskSummarySelect} WHERE t.status='queued' ORDER BY t.created_at ASC, t.id ASC`)
				.all()
				.map((row) => parseTaskSummary(row, "malformed queued task row"));
			const visible =
				caps === undefined ? queued : queued.filter((t) => caps.includes(t.capability));
			return {
				ok: true,
				ready: visible.filter((t) => isClaimable(db, t)),
				blocked: visible
					.filter((t) => !isClaimable(db, t))
					.map((t) => {
						const blockers = unresolvedDependencies(db, t.id).map((id) => {
							const blocker = taskSummary(db, id);
							return { id: blocker.id, scope_id: blocker.scope_id, status: blocker.status };
						});
						return { ...t, unresolved_dependency_ids: blockers.map((b) => b.id), blockers };
					}),
			};
		}),
	supersede: ({ taskId, runId, reason, title, body, bodyFile, scope, capability }) =>
		withDb(ctx, (db) => {
			const actorRunId = resolveRunId(ctx, runId);
			liveRun(db, actorRunId);
			const nonEmptyReason = requireNonEmpty(reason, "--reason");
			const replacementId = Effect.runSync(ctx.services.ids.make("task"));
			const old =
				(db.prepare(sql`SELECT * FROM tasks WHERE id=?`).get(taskId) as
					| (TaskSummary & { body: string; max_attempts: number })
					| undefined) ?? fail("NOT_FOUND", `task not found: ${taskId}`);
			if (!["queued", "failed", "dead_letter", "cancelled"].includes(old.status)) {
				fail("VALIDATION_ERROR", `task status cannot be superseded: ${old.status}`);
			}
			const replacementScope = scope ?? old.scope_id;
			const replacementCap = capability ?? old.capability;
			authorized(db, "agent_enqueues", actorRunId, replacementCap);
			enforceCapScope(db, replacementScope, replacementCap);
			const replacementBody =
				body === undefined && bodyFile === undefined ? old.body : resolveBody(ctx, body, bodyFile);
			const replacementTitle = title ?? old.title;
			return db.transaction(() => {
				if (
					db.prepare(sql`SELECT 1 FROM task_supersessions WHERE old_task_id=?`).get(taskId) !==
					undefined
				)
					fail("VALIDATION_ERROR", "task has already been superseded");
				const dependents = db
					.prepare(
						sql`SELECT t.id, t.status FROM tasks t JOIN task_dependencies td ON td.task_id=t.id WHERE td.depends_on_task_id=?`,
					)
					.all(taskId) as { id: string; status: string }[];
				const retargeted = dependents.filter((d) => d.status === "queued").map((d) => d.id);
				const invalid = dependents.find((d) => d.status !== "queued" && d.status !== "cancelled");
				if (invalid !== undefined)
					fail("VALIDATION_ERROR", `dependent task is not queued: ${invalid.id}`);
				if (replacementScope !== old.scope_id && retargeted.length > 0)
					fail("VALIDATION_ERROR", "cannot change scope while retargeting queued dependents");
				db.prepare(
					sql`INSERT INTO tasks(id,scope_id,capability,title,body,max_attempts,created_by_run_id) VALUES (?,?,?,?,?,?,?)`,
				).run(
					replacementId,
					replacementScope,
					replacementCap,
					replacementTitle,
					replacementBody,
					old.max_attempts,
					actorRunId,
				);
				for (const dep of db
					.prepare(sql`SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id=?`)
					.all(taskId) as { id: string }[])
					db.prepare(
						sql`INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES (?,?)`,
					).run(replacementId, dep.id);
				for (const id of retargeted)
					db.prepare(
						sql`UPDATE task_dependencies SET depends_on_task_id=? WHERE task_id=? AND depends_on_task_id=?`,
					).run(replacementId, id, taskId);
				db.prepare(
					sql`INSERT INTO task_supersessions(old_task_id,new_task_id,created_by_run_id,reason) VALUES (?,?,?,?)`,
				).run(taskId, replacementId, actorRunId, nonEmptyReason);
				if (old.status === "queued") {
					db.prepare(
						sql`UPDATE tasks SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?`,
					).run(taskId);
					event(ctx, db, "task.cancelled", {
						task_id: taskId,
						actor_run_id: actorRunId,
						payload: { reason: nonEmptyReason, superseded_by_task_id: replacementId },
					});
				}
				event(ctx, db, "task.created", {
					task_id: replacementId,
					actor_run_id: actorRunId,
					payload: {
						scope_id: replacementScope,
						capability: replacementCap,
						title: replacementTitle,
						depends_on_task_ids: (
							db
								.prepare(
									sql`SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id=?`,
								)
								.all(replacementId) as { id: string }[]
						).map((r) => r.id),
						supersedes_task_id: taskId,
					},
				});
				event(ctx, db, "task.superseded", {
					task_id: taskId,
					actor_run_id: actorRunId,
					payload: {
						new_task_id: replacementId,
						reason: nonEmptyReason,
						retargeted_dependent_task_ids: retargeted,
					},
				});
				assertAcyclic(db);
				return {
					ok: true as const,
					task: {
						id: replacementId,
						status: "queued" as const,
						scope_id: replacementScope,
						capability: replacementCap,
					},
					supersession: {
						old_task_id: taskId,
						new_task_id: replacementId,
						retargeted_dependent_task_ids: retargeted,
					},
				};
			})();
		}),
});

export const enforceCapScope = (db: Db, scopeId: string, cap: Capability): void => {
	const s = decodeRow(
		ScopeRowSchema,
		db.prepare(sql`SELECT id,kind,canonical_path FROM scopes WHERE id=?`).get(scopeId),
		`scope not found: ${scopeId}`,
	);

	if (cap === "escalate" && s.kind !== "global") {
		fail("VALIDATION_ERROR", `escalate requires global scope; got ${scopeId}`);
	}

	if (
		cap === "execute" &&
		!((s.kind === "repo" || s.kind === "worktree") && s.canonical_path !== null)
	) {
		fail(
			"VALIDATION_ERROR",
			`execute requires repo/worktree scope with canonical_path; got ${scopeId} kind=${s.kind}`,
		);
	}
};

export { authorized, event };
