import { Effect, Either, ParseResult, Schema } from "effect";
import { resolve } from "node:path";
import {
	finalDependencyIds,
	resolveChainPolicy,
	type ChainPolicy,
	type ChainPolicyDecision,
} from "./chain-policy.js";
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
	type SourceKind,
	type TaskStatus,
} from "./db.js";
import { fail } from "./errors.js";
import {
	decodeRow,
	EventRowSchema,
	RepairAlertKindSchema,
	RunRowSchema,
	ScopeRowSchema,
	TaskRowSchema,
	type RepairAlertKind,
	type RunRow,
	type ScopeRow,
} from "./rows.js";
import type { Services } from "./services.js";

export const PDX_SYSTEM_RUN_ID = "run_pdx_system";

export interface EngineContext {
	readonly config: Config;
	readonly services: Services;
}

export interface Engine {
	readonly init: (input: { readonly fresh: boolean }) => { readonly ok: true };
	readonly scopeUpsert: (input: {
		readonly kind: ScopeKind;
		readonly path: string | undefined;
		readonly description?: string | undefined;
	}) => {
		readonly ok: true;
		readonly scope: ScopeIdentityOutput;
	};
	readonly scopeList: (input: { readonly all: boolean }) => {
		readonly ok: true;
		readonly scopes: readonly ScopeOutput[];
	};
	readonly scopeArchive: (input: { readonly scopeId: string }) => {
		readonly ok: true;
		readonly action: "archived" | "deleted";
		readonly scope: ScopeOutput;
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
	readonly runLaunchAbort: (input: { readonly runId: string; readonly reason: string }) => {
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
		readonly chain: ChainPolicy;
	}) => EnqueueOutput;
	readonly claim: (input: {
		readonly runId: string | undefined;
		readonly scope: string;
		readonly capability: Capability;
	}) => {
		readonly ok: true;
		readonly task: {
			readonly id: string;
			readonly status: "claimed";
			readonly token: number;
			readonly capability: Capability;
		};
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
		readonly resultJson: string;
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
		readonly hideTerminal: boolean;
	}) => GraphInspectOutput;
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
	readonly escalateLaunchPrecondition: (input: {
		readonly runId: string | undefined;
		readonly expectedTaskId: string;
		readonly expectedScopeId: string;
		readonly expectedCapability: Capability;
		readonly canonicalPath: string;
		readonly agentKind: string;
		readonly reason: string;
		readonly escalationTitle: string;
		readonly escalationBody: string;
	}) => LaunchPreconditionEscalationOutput;
	readonly createRepairAlert: (input: {
		readonly runId: string | undefined;
		readonly affectedTaskId?: string;
		readonly kind: RepairAlertKind;
		readonly escalationTitle: string;
		readonly escalationBody: string;
	}) => RepairAlertOutput;
	readonly claimableRepairAlertKinds: () => {
		readonly ok: true;
		readonly kinds: readonly RepairAlertKind[];
	};
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
	readonly scope_description: string | null;
	readonly capability: Capability;
	readonly status: TaskStatus;
	readonly title: string;
	readonly created_at: string;
	readonly completed_at: string | null;
}

export interface TaskDetailOutput extends TaskSummaryOutput {
	readonly body: string;
	readonly fencing_token: number;
	readonly attempts: number;
	readonly max_attempts: number;
}

export interface TaskInspectTaskOutput extends TaskDetailOutput {
	readonly claimable: boolean;
	readonly unresolved_dependency_ids: readonly string[];
}

export interface LineageEntryOutput {
	readonly depth: number;
	readonly via_task_ids: readonly string[];
	readonly task: TaskInspectTaskOutput;
	readonly supersedes: string | null;
	readonly superseded_by: string | null;
	readonly artifacts: readonly ArtifactOutput[];
}

export interface TaskSourceSummaryOutput extends TaskSummaryOutput {
	readonly source_kind: SourceKind;
}

export interface TaskInspectOutput {
	readonly ok: true;
	readonly task: TaskInspectTaskOutput;
	readonly dependencies: readonly TaskDetailOutput[];
	readonly dependents: readonly TaskDetailOutput[];
	readonly source: TaskSourceSummaryOutput | null;
	readonly lineage: readonly LineageEntryOutput[];
	readonly supersedes: string | null;
	readonly superseded_by: string | null;
	readonly artifacts: readonly ArtifactOutput[];
	readonly repair_alert_kind: RepairAlertKind | null;
}

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
	readonly source_task_id: string | null;
	readonly source_kind: SourceKind | null;
}

export type GraphEdgeOutput =
	| {
			readonly kind: "depends_on";
			readonly from_task_id: string;
			readonly to_task_id: string;
			readonly satisfied: boolean;
	  }
	| {
			readonly kind: "source";
			readonly from_task_id: string;
			readonly to_task_id: string;
			readonly source_kind: SourceKind;
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
	readonly scope_description: string | null;
}

export interface BlockedTaskOutput extends TaskSummaryOutput {
	readonly unresolved_dependency_ids: readonly string[];
	readonly blockers: readonly BlockerOutput[];
}

export interface BriefingOutput {
	readonly ok: true;
	readonly ready: readonly TaskSummaryOutput[];
	readonly blocked: readonly BlockedTaskOutput[];
	readonly recentlyCompleted: readonly TaskSummaryOutput[];
}

export interface ChainOutput {
	readonly policy: ChainPolicy;
	readonly applied: ChainPolicyDecision["applied"];
	readonly held_task_id: string | null;
	readonly source_task_id: string | null;
	readonly source_kind: SourceKind | null;
	readonly implicit_dependency_ids: readonly string[];
	readonly final_dependency_ids: readonly string[];
}

export interface EnqueueOutput {
	readonly ok: true;
	readonly task: { readonly id: string; readonly status: "queued" };
	readonly chain: ChainOutput;
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

export interface LaunchPreconditionEscalationOutput {
	readonly ok: true;
	readonly task: { readonly id: string; readonly status: "cancelled" };
	readonly escalation: {
		readonly id: string;
		readonly status: "queued";
		readonly scope_id: "global";
		readonly capability: "escalate";
		readonly source_task_id: string;
		readonly source_kind: "repair_source";
	};
}

export interface RepairAlertOutput {
	readonly ok: true;
	readonly escalation: {
		readonly id: string;
		readonly status: "queued";
		readonly scope_id: "global";
		readonly capability: "escalate";
		readonly source_task_id: string | null;
		readonly source_kind: "repair_source" | null;
		readonly kind: RepairAlertKind;
	};
}

export interface ScopeIdentityOutput {
	readonly id: string;
	readonly kind: ScopeKind;
	readonly canonical_path: string | null;
	readonly archived_at: string | null;
	readonly description: string | null;
}

export interface ScopeOutput extends ScopeIdentityOutput {
	readonly task_count: number;
	readonly run_count: number;
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
RETURNING id, fencing_token, capability
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

// Used when --description is omitted: preserves any existing description value.
const upsertScopePreserveDescription = sql`
INSERT INTO scopes(
	id,
	kind,
	canonical_path
) VALUES (?, ?, ?)
ON CONFLICT(id)
DO UPDATE SET
	kind = excluded.kind,
	canonical_path = excluded.canonical_path,
	archived_at = NULL,
	updated_at = CURRENT_TIMESTAMP
RETURNING id, kind, canonical_path, archived_at, description
`;

// Used when --description is explicitly provided: sets or clears the description.
const upsertScopeSetDescription = sql`
INSERT INTO scopes(
	id,
	kind,
	canonical_path,
	description
) VALUES (?, ?, ?, ?)
ON CONFLICT(id)
DO UPDATE SET
	kind = excluded.kind,
	canonical_path = excluded.canonical_path,
	description = excluded.description,
	archived_at = NULL,
	updated_at = CURRENT_TIMESTAMP
RETURNING id, kind, canonical_path, archived_at, description
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

const insertRun = sql`
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

const scopeSelect = sql`
SELECT id, kind, canonical_path, archived_at, description
FROM scopes
`;

// Surfaces SQLite PRIMARY KEY constraint violations as ID_COLLISION errors.
// The transaction rolls back automatically (better-sqlite3 throws on error).
const withCollisionGuard = <A>(id: string, fn: () => A): A => {
	try {
		return fn();
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
		) {
			fail("ID_COLLISION", `generated ID already exists: ${id}`);
		}
		throw error;
	}
};

const event = (
	ctx: EngineContext,
	db: Db,
	type: string,
	payload: { task_id?: string; run_id?: string; actor_run_id?: string; payload: Json },
): void => {
	const eventId = Effect.runSync(ctx.services.ids.make("event"));
	withCollisionGuard(eventId, () =>
		db
			.prepare(eventPayload)
			.run(
				eventId,
				type,
				payload.task_id ?? null,
				payload.run_id ?? null,
				payload.actor_run_id ?? null,
				JSON.stringify(payload.payload),
			),
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

const scopeById = (db: Db, scopeId: string): ScopeRow =>
	decodeRow(
		ScopeRowSchema,
		db.prepare(`${scopeSelect} WHERE id=?`).get(scopeId),
		`scope not found: ${scopeId}`,
	);

const enforceActiveScope = (scope: ScopeRow): void => {
	if (scope.archived_at !== null) {
		fail("VALIDATION_ERROR", `scope is archived: ${scope.id}`);
	}
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
		scope_description: Schema.NullOr(Schema.String),
		completed_at: Schema.NullOr(Schema.String),
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
SELECT t.id, t.scope_id, s.kind AS scope_kind, s.canonical_path, s.description AS scope_description, t.capability, t.title, t.body, t.status, t.fencing_token, t.attempts, t.max_attempts, t.created_at, t.completed_at
FROM tasks t
JOIN scopes s ON s.id = t.scope_id
`;

const toTaskSummary = (row: TaskSummaryRow): TaskSummary => ({
	id: row.id,
	scope_id: row.scope_id,
	scope_kind: row.scope_kind,
	canonical_path: row.canonical_path,
	scope_description: row.scope_description,
	capability: row.capability,
	status: row.status,
	title: row.title,
	created_at: row.created_at,
	completed_at: row.completed_at,
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
	archived_at: row.archived_at,
	description: row.description,
});

const parseScopeIdentity = (value: unknown, message: string): ScopeIdentityOutput =>
	toScopeIdentityOutput(decodeRow(ScopeRowSchema, value, message));

const toScopeOutput = (row: ScopeListRow): ScopeOutput => ({
	...toScopeIdentityOutput(row),
	task_count: row.task_count,
	run_count: row.run_count,
});

const parseScopeOutput = (value: unknown, message: string): ScopeOutput =>
	toScopeOutput(decodeRow(ScopeListRowSchema, value, message));

const parseScopeArchiveCheck = (value: unknown, message: string): ScopeArchiveCheckRow =>
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

const compareTaskCreatedAt = <T extends { readonly created_at: string; readonly id: string }>(
	a: T,
	b: T,
): number => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

const taskSummary = (db: Db, taskId: string): TaskSummary =>
	parseTaskSummary(
		db.prepare(`${taskSummarySelect} WHERE t.id = ?`).get(taskId),
		`task not found: ${taskId}`,
	);

const taskDetail = (db: Db, taskId: string): TaskDetailOutput =>
	parseTaskDetail(
		db.prepare(`${taskSummarySelect} WHERE t.id = ?`).get(taskId),
		`task not found: ${taskId}`,
	);

const taskArtifacts = (db: Db, taskId: string): readonly ArtifactOutput[] =>
	db
		.prepare(
			sql`SELECT id, kind, title, body, created_at FROM artifacts WHERE task_id=? ORDER BY created_at ASC, id ASC`,
		)
		.all(taskId)
		.map(parseArtifact);

const taskSupersessionLinks = (
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

const taskSourceEdges = (db: Db): readonly TaskSourceEdgeRow[] =>
	db
		.prepare(sql`SELECT task_id, source_task_id, kind FROM task_sources`)
		.all()
		.map(parseTaskSourceEdge);

const taskSourceEdge = (db: Db, taskId: string): TaskSourceEdgeRow | null => {
	const row = db
		.prepare(sql`SELECT task_id, source_task_id, kind FROM task_sources WHERE task_id=?`)
		.get(taskId);
	return row === undefined ? null : parseTaskSourceEdge(row);
};

const taskSourceSummary = (db: Db, taskId: string): TaskSourceSummaryOutput | null => {
	const edge = taskSourceEdge(db, taskId);
	return edge === null ? null : { ...taskSummary(db, edge.source_task_id), source_kind: edge.kind };
};

const validateReferenceTaskCurrent = (db: Db, taskId: string, label: string): void => {
	const exists = db.prepare(sql`SELECT 1 FROM tasks WHERE id = ?`).get(taskId);
	if (exists === undefined) fail("NOT_FOUND", `${label} task not found: ${taskId}`);
	const replacement = db
		.prepare(sql`SELECT new_task_id FROM task_supersessions WHERE old_task_id = ?`)
		.pluck()
		.get(taskId) as string | undefined;
	if (replacement !== undefined)
		fail("VALIDATION_ERROR", `${label} task ${taskId} was superseded by ${replacement}`);
};

const insertTaskSource = (
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

const sortTaskIdsDeterministically = (db: Db, taskIds: readonly string[]): readonly string[] =>
	taskIds
		.map((taskId) => taskSummary(db, taskId))
		.sort(compareTaskCreatedAt)
		.map((task) => task.id);

const isClaimable = (db: Db, task: { readonly id: string; readonly status: string }): boolean =>
	task.status === "queued" && unresolvedDependencies(db, task.id).length === 0;

const taskInspectTask = (db: Db, taskId: string): TaskInspectTaskOutput => {
	const task = taskDetail(db, taskId);
	return {
		...task,
		claimable: isClaimable(db, task),
		unresolved_dependency_ids: unresolvedDependencies(db, taskId),
	};
};

const taskLineage = (db: Db, taskId: string): readonly LineageEntryOutput[] => {
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

export const renderGraphInspectText = ({ graph }: GraphInspectOutput): string => {
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
	// supersedes edge: from=successor (new), to=superseded (old)
	const successorBySuperseded = new Map<string, string>();
	const successorIds = new Set<string>();
	for (const edge of graph.edges) {
		if (edge.kind !== "supersedes") continue;
		if (!byId.has(edge.from_task_id) || !byId.has(edge.to_task_id)) continue;
		successorBySuperseded.set(edge.to_task_id, edge.from_task_id);
		successorIds.add(edge.from_task_id);
	}
	const ONE_HOUR_MS = 60 * 60 * 1000;
	const now = Date.now();
	// SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" with no timezone suffix; treat as UTC.
	const parseSqliteUtcMs = (s: string): number => Date.parse(`${s.replace(" ", "T")}Z`);
	const isTerminal = (node: GraphNodeOutput): boolean => {
		if (node.status === "done") return true;
		if (
			(node.status === "failed" || node.status === "dead_letter" || node.status === "cancelled") &&
			node.completed_at !== null
		) {
			return now - parseSqliteUtcMs(node.completed_at) >= ONE_HOUR_MS;
		}
		return false;
	};
	// Transitively mark successor nodes as visible when their superseded predecessor is non-terminal.
	// This makes completed supersession chains visible even though all their nodes are terminal.
	const supersessionVisible = new Set<string>();
	for (const [supersededId, successorId] of successorBySuperseded.entries()) {
		const superseded = byId.get(supersededId);
		if (superseded !== undefined && !isTerminal(superseded)) {
			const queue = [successorId];
			while (queue.length > 0) {
				const id = queue.shift()!;
				if (supersessionVisible.has(id) || !byId.has(id)) continue;
				supersessionVisible.add(id);
				for (const childId of childrenByParent.get(id) ?? []) queue.push(childId);
			}
		}
	}
	const selectedTaskId = graph.selector.kind === "task" ? graph.selector.value : undefined;
	const visible = (id: string): boolean => {
		const node = byId.get(id);
		if (node === undefined) return false;
		if (id === selectedTaskId) return true;
		if (!isTerminal(node)) return true;
		const successorId = successorBySuperseded.get(id);
		const hasActiveSuccessor = successorId !== undefined && visible(successorId);
		return (
			(childrenByParent.get(id) ?? []).some(visible) ||
			supersessionVisible.has(id) ||
			hasActiveSuccessor
		);
	};
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
		if (node === undefined || !visible(id)) return;
		const prefix = supersessionChild ? "~> " : "- ";
		if (written.has(id)) {
			lines.push(`${"  ".repeat(depth)}${prefix}↑ ${id} already shown`);
			return;
		}
		lines.push(`${"  ".repeat(depth)}${prefix}${taskTitleLine(node)}`);
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

const insertRepairAlert = (db: Db, alertTaskId: string, kind: RepairAlertKind): void => {
	db.prepare(sql`INSERT INTO repair_alerts(task_id, kind) VALUES (?, ?)`).run(alertTaskId, kind);
};

const ensureSystemRunRow = (db: Db): void => {
	// The system-actor run must exist before any repair alert insert (tasks FK).
	// pdx upserts this row with real values via runUpsert on daemon start; this
	// INSERT OR IGNORE handles early-startup cleanup and standalone CLI paths.
	db.prepare(
		sql`INSERT OR IGNORE INTO runs(id,agent_kind,mode,scope_id,cwd,session_id,harness_kind,session_log_path) VALUES ('run_pdx_system','pdx','afk','global','/pdx','run_pdx_system','system','/dev/null')`,
	).run();
};

const createRepairAlertInTxn = (
	ctx: EngineContext,
	db: Db,
	input: {
		readonly kind: RepairAlertKind;
		readonly affectedTaskId: string | undefined;
		readonly escalationTitle: string;
		readonly escalationBody: string;
	},
): void => {
	ensureSystemRunRow(db);
	const alertId = Effect.runSync(ctx.services.ids.make("task"));
	db.prepare(
		sql`INSERT INTO tasks(id,scope_id,capability,title,body,created_by_run_id) VALUES (?,?,?,?,?,?)`,
	).run(
		alertId,
		"global",
		"escalate",
		input.escalationTitle,
		input.escalationBody,
		PDX_SYSTEM_RUN_ID,
	);
	insertRepairAlert(db, alertId, input.kind);
	if (input.affectedTaskId !== undefined) {
		insertTaskSource(db, alertId, input.affectedTaskId, PDX_SYSTEM_RUN_ID, "repair_source");
	}
	event(ctx, db, "task.created", {
		task_id: alertId,
		actor_run_id: PDX_SYSTEM_RUN_ID,
		payload: {
			scope_id: "global",
			capability: "escalate",
			title: input.escalationTitle,
			depends_on_task_ids: [],
			...(input.affectedTaskId !== undefined
				? { source_task_id: input.affectedTaskId, source_kind: "repair_source" }
				: {}),
		},
	});
};

const createRepairAlertTask = (
	ctx: EngineContext,
	db: Db,
	input: {
		readonly actorRunId: string;
		readonly affectedTaskId: string | undefined;
		readonly kind: RepairAlertKind;
		readonly escalationTitle: string;
		readonly escalationBody: string;
	},
): RepairAlertOutput => {
	const actorRun = liveRun(db, input.actorRunId);
	if (actorRun.agent_kind !== "pdx") {
		fail("VALIDATION_ERROR", "repair alert must be authored by pdx");
	}
	scopeForCapability(db, "global", "escalate");
	const affectedTask =
		input.affectedTaskId !== undefined ? taskSummary(db, input.affectedTaskId) : undefined;
	const title = requireNonEmpty(input.escalationTitle, "escalation title");
	const bodyText = requireNonEmpty(input.escalationBody, "escalation body");
	const escalationId = Effect.runSync(ctx.services.ids.make("task"));
	return withCollisionGuard(escalationId, () =>
		db.transaction((): RepairAlertOutput => {
			db.prepare(
				sql`INSERT INTO tasks(id,scope_id,capability,title,body,created_by_run_id) VALUES (?,?,?,?,?,?)`,
			).run(escalationId, "global", "escalate", title, bodyText, input.actorRunId);
			insertRepairAlert(db, escalationId, input.kind);
			if (affectedTask !== undefined) {
				insertTaskSource(db, escalationId, affectedTask.id, input.actorRunId, "repair_source");
			}
			event(ctx, db, "task.created", {
				task_id: escalationId,
				actor_run_id: input.actorRunId,
				payload: {
					scope_id: "global",
					capability: "escalate",
					title,
					depends_on_task_ids: [],
					...(affectedTask !== undefined
						? { source_task_id: affectedTask.id, source_kind: "repair_source" }
						: {}),
				},
			});
			return {
				ok: true as const,
				escalation: {
					id: escalationId,
					status: "queued" as const,
					scope_id: "global" as const,
					capability: "escalate" as const,
					source_task_id: affectedTask?.id ?? null,
					source_kind: affectedTask !== undefined ? ("repair_source" as const) : null,
					kind: input.kind,
				},
			};
		})(),
	);
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

const terminalLeafStatuses = new Set(["done", "failed", "dead_letter", "cancelled"]);

const filterTerminalLeaves = (
	graph: GraphInspectOutput["graph"],
	pinnedTaskId: string | undefined,
): GraphInspectOutput["graph"] => {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	// dependents[parent] = tasks that depend on parent (depends_on: from=child, to=parent)
	const dependents = new Map<string, string[]>();
	// successorsOf[superseded] = successors (supersedes: from=successor, to=superseded)
	const successorsOf = new Map<string, string[]>();
	// sourceConsumers[source] = tasks that reference source via chain/repair source link (source: from=consumer, to=source)
	const sourceConsumers = new Map<string, string[]>();
	for (const edge of graph.edges) {
		if (edge.kind === "depends_on") {
			dependents.set(edge.to_task_id, [
				...(dependents.get(edge.to_task_id) ?? []),
				edge.from_task_id,
			]);
		} else if (edge.kind === "supersedes") {
			successorsOf.set(edge.to_task_id, [
				...(successorsOf.get(edge.to_task_id) ?? []),
				edge.from_task_id,
			]);
		} else if (edge.kind === "source") {
			sourceConsumers.set(edge.to_task_id, [
				...(sourceConsumers.get(edge.to_task_id) ?? []),
				edge.from_task_id,
			]);
		}
	}
	const hidden = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of graph.nodes) {
			if (hidden.has(node.id) || node.id === pinnedTaskId) continue;
			if (!terminalLeafStatuses.has(node.status)) continue;
			const downstream = [
				...(dependents.get(node.id) ?? []),
				...(successorsOf.get(node.id) ?? []),
				...(sourceConsumers.get(node.id) ?? []),
			];
			if (downstream.every((id) => hidden.has(id) || !byId.has(id))) {
				hidden.add(node.id);
				changed = true;
			}
		}
	}
	if (hidden.size === 0) return graph;
	return {
		...graph,
		nodes: graph.nodes.filter((n) => !hidden.has(n.id)),
		edges: graph.edges.filter((e) => !hidden.has(e.from_task_id) && !hidden.has(e.to_task_id)),
	};
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
	scopeUpsert: ({ kind, path, description }) =>
		withDb(ctx, (db) => {
			if (!(["global", "repo", "worktree"] as const).includes(kind)) {
				fail("VALIDATION_ERROR", `invalid scope kind: ${kind}`);
			}

			const rawPath =
				kind === "global"
					? undefined
					: requireNonEmpty(path ?? fail("VALIDATION_ERROR", "missing --path"), "--path");
			const canonical = rawPath === undefined ? null : resolve(rawPath);
			if ((kind === "repo" || kind === "worktree") && canonical !== null) {
				const existsDirectory = Effect.runSync(ctx.services.fs.existsDirectory(canonical));
				if (!existsDirectory) {
					fail(
						"VALIDATION_ERROR",
						`${kind} scope path must exist as a directory before upsert: ${canonical}. Create the directory first, then upsert the scope.`,
					);
				}
			}
			const sid = kind === "global" ? "global" : `${kind}:${canonical}`;
			const scopeRow = parseScopeIdentity(
				description !== undefined
					? db.prepare(upsertScopeSetDescription).get(sid, kind, canonical, description)
					: db.prepare(upsertScopePreserveDescription).get(sid, kind, canonical),
				`scope not found after upsert: ${sid}`,
			);
			return { ok: true, scope: scopeRow };
		}),
	scopeList: ({ all }) =>
		withDb(ctx, (db) => ({
			ok: true,
			scopes: db
				.prepare(sql`
					SELECT
						s.id,
						s.kind,
						s.canonical_path,
						s.archived_at,
						s.description,
						COUNT(DISTINCT t.id) AS task_count,
						COUNT(DISTINCT r.id) AS run_count
					FROM scopes s
					LEFT JOIN tasks t ON t.scope_id = s.id
					LEFT JOIN runs r ON r.scope_id = s.id
					${all ? "" : "WHERE s.archived_at IS NULL"}
					GROUP BY s.id, s.kind, s.canonical_path, s.archived_at, s.description
					ORDER BY s.archived_at IS NOT NULL ASC, s.kind ASC, s.canonical_path ASC, s.id ASC
				`)
				.all()
				.map((row) => parseScopeOutput(row, "malformed scope row")),
		})),
	scopeArchive: ({ scopeId }) =>
		withDb(ctx, (db) =>
			db.transaction(
				(): {
					readonly ok: true;
					readonly action: "archived" | "deleted";
					readonly scope: ScopeOutput;
				} => {
					const scope = parseScopeArchiveCheck(
						db
							.prepare(sql`
						SELECT
							s.id,
							s.kind,
							s.canonical_path,
							s.archived_at,
							s.description,
							COUNT(DISTINCT t.id) AS task_count,
							COUNT(DISTINCT r.id) AS run_count,
							COUNT(DISTINCT CASE WHEN r.status = 'live' THEN r.id END) AS live_run_count,
							COUNT(DISTINCT CASE WHEN t.status IN ('queued', 'claimed', 'running') THEN t.id END) AS active_task_count
						FROM scopes s
						LEFT JOIN tasks t ON t.scope_id = s.id
						LEFT JOIN runs r ON r.scope_id = s.id
						WHERE s.id = ?
						GROUP BY s.id, s.kind, s.canonical_path, s.archived_at, s.description
					`)
							.get(scopeId),
						`scope not found: ${scopeId}`,
					);
					if (scope.kind === "global") {
						fail("VALIDATION_ERROR", "cannot archive built-in global scope");
					}
					if (scope.live_run_count > 0) {
						fail(
							"VALIDATION_ERROR",
							`scope ${scopeId} still has ${scope.live_run_count} live run(s)`,
						);
					}
					if (scope.active_task_count > 0) {
						fail(
							"VALIDATION_ERROR",
							`scope ${scopeId} still has ${scope.active_task_count} non-terminal task(s)`,
						);
					}
					if (scope.task_count === 0 && scope.run_count === 0) {
						const deleted = db.prepare(sql`DELETE FROM scopes WHERE id=?`).run(scopeId);
						if (deleted.changes === 0) fail("STALE_TOKEN_RACE", "scope changed before archive");
						return { ok: true, action: "deleted" as const, scope: toScopeOutput(scope) };
					}
					const archivedScope = parseScopeIdentity(
						db
							.prepare(
								sql`UPDATE scopes SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, kind, canonical_path, archived_at, description`,
							)
							.get(scopeId),
						`scope not found after archive: ${scopeId}`,
					);
					return {
						ok: true,
						action: "archived" as const,
						scope: {
							...archivedScope,
							task_count: scope.task_count,
							run_count: scope.run_count,
						},
					};
				},
			)(),
		),
	runUpsert: ({ agent, mode, scope, cwd, harnessKind, sessionLogPath, sessionId, runId }) =>
		withDb(ctx, (db) => {
			const agentExists = db
				.prepare(sql`SELECT 1 FROM agent_kinds WHERE agent_kind = ?`)
				.get(agent);
			if (agentExists === undefined) fail("VALIDATION_ERROR", `unknown agent kind: ${agent}`);

			enforceActiveScope(scopeById(db, scope));

			const callerProvidedId = runId !== undefined;
			const rid = requireNonEmpty(runId ?? Effect.runSync(ctx.services.ids.make("run")), "--run");
			const runArgs = [
				rid,
				agent,
				mode,
				scope,
				requireNonEmpty(cwd, "--cwd"),
				requireNonEmpty(sessionId, "--session-id"),
				parseHarnessKind(harnessKind),
				requireNonEmpty(sessionLogPath, "--session-log-path"),
			] as const;
			if (callerProvidedId) {
				// Caller-provided IDs use UPSERT for intentional re-registration (e.g. daemon restart).
				db.prepare(upsertRun).run(...runArgs);
			} else {
				// Engine-generated IDs use plain INSERT: collision means the word combination
				// was already taken, which must fail loudly rather than overwrite.
				withCollisionGuard(rid, () => db.prepare(insertRun).run(...runArgs));
			}
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
						nextTaskStatus === "dead_letter"
							? sql`
						UPDATE tasks
						SET status=?, fencing_token=fencing_token + 1, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
						WHERE id=? AND status=? AND fencing_token=?
					`
							: sql`
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
				if (nextTaskStatus === "dead_letter") {
					createRepairAlertInTxn(ctx, db, {
						kind: "dead_letter",
						affectedTaskId: task.id,
						escalationTitle: `Investigate dead-lettered task ${task.id}`,
						escalationBody: `Task ${task.id} exhausted its ${task.max_attempts} attempts and entered dead_letter state (scope: ${task.scope_id}, capability: ${task.capability}).\n\nReason: ${nonEmptyReason}\n\nInvestigate the task history, fix the underlying issue, and supersede the task to restart the work.`,
					});
				}
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
						createRepairAlertInTxn(ctx, db, {
							kind: "interrupt",
							affectedTaskId: task.id,
							escalationTitle: `Investigate interrupted task ${task.id}`,
							escalationBody: `Task ${task.id} was interrupted while held by run ${run.id} (scope: ${task.scope_id}, capability: ${task.capability}).\n\nReason: ${nonEmptyReason}\n\nInvestigate the task, determine if the work should be resumed, and take the appropriate action (supersede, re-enqueue, or accept the failure).`,
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
	runLaunchAbort: ({ runId, reason }) =>
		withDb(ctx, (db) => {
			const nonEmptyReason = requireNonEmpty(reason, "--reason");
			const finalRun: RunRow = db.transaction((): RunRow => {
				const run = runById(db, runId);
				if (run.status !== "live") {
					fail("VALIDATION_ERROR", "launch abort requires a live run");
				}
				if (run.task_id !== null) {
					fail("VALIDATION_ERROR", "launch abort requires no held task");
				}
				const hasClaimed = db
					.prepare(sql`SELECT 1 FROM events WHERE type='task.claimed' AND actor_run_id=?`)
					.get(run.id);
				if (hasClaimed !== undefined) {
					fail("VALIDATION_ERROR", "launch abort requires a run that has never claimed a task");
				}
				const runUpdate = db
					.prepare(
						sql`UPDATE runs SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='live' AND task_id IS NULL`,
					)
					.run(run.id);
				if (runUpdate.changes === 0) {
					fail("STALE_TOKEN_RACE", "launch abort run snapshot changed before update");
				}
				event(ctx, db, "run.launch_aborted", {
					run_id: run.id,
					payload: { reason: nonEmptyReason, previous_status: run.status, status: "cancelled" },
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
	enqueue: ({ scope, capability, title, body, bodyFile, runId, dependsOn, chain }) =>
		withDb(ctx, (db) => {
			const actorRunId = resolveRunId(ctx, runId);
			authorized(db, "agent_enqueues", actorRunId, capability);
			enforceTaskAdmissionScope(ctx, db, scope, capability);
			const uniqueDepends = new Set(dependsOn);
			if (uniqueDepends.size !== dependsOn.length) {
				fail("VALIDATION_ERROR", "duplicate --depends-on task id");
			}
			const taskBody = resolveBody(ctx, body, bodyFile);
			const taskTitle = requireNonEmpty(title, "--title");
			const taskId = Effect.runSync(ctx.services.ids.make("task"));

			const chainOutput = withCollisionGuard(taskId, () =>
				db.transaction((): ChainOutput => {
					const actorRun = liveRun(db, actorRunId);
					const heldTask = actorRun.task_id === null ? null : taskSummary(db, actorRun.task_id);
					const heldSource =
						actorRun.task_id === null ? null : taskSourceEdge(db, actorRun.task_id);
					const decision = resolveChainPolicy({
						policy: chain,
						newTaskCapability: capability,
						heldTask,
						heldSource:
							heldSource === null
								? null
								: { taskId: heldSource.source_task_id, kind: heldSource.kind },
					});
					const dependencyIds = finalDependencyIds({
						manualDependencyIds: dependsOn,
						implicitDependencyIds: decision.implicitDependencyIds,
					});
					const output: ChainOutput = {
						policy: decision.policy,
						applied: decision.applied,
						held_task_id: decision.heldTaskId,
						source_task_id: decision.sourceTaskId,
						source_kind: decision.sourceKind,
						implicit_dependency_ids: decision.implicitDependencyIds,
						final_dependency_ids: dependencyIds,
					};
					for (const depId of dependencyIds) {
						validateReferenceTaskCurrent(db, depId, "dependency");
					}
					db.prepare(
						sql`INSERT INTO tasks(id,scope_id,capability,title,body,created_by_run_id) VALUES (?,?,?,?,?,?)`,
					).run(taskId, scope, capability, taskTitle, taskBody, actorRunId);
					for (const depId of dependencyIds) {
						db.prepare(
							sql`INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES (?,?)`,
						).run(taskId, depId);
					}
					if (decision.applied === "source_from_held") {
						insertTaskSource(
							db,
							taskId,
							decision.sourceTaskId ??
								fail("INTERNAL_ERROR", "source decision missing source task"),
							actorRunId,
							"chain_source",
						);
					}
					assertAcyclic(db);
					event(ctx, db, "task.created", {
						task_id: taskId,
						actor_run_id: actorRunId,
						payload: {
							scope_id: scope,
							capability,
							title: taskTitle,
							depends_on_task_ids: dependencyIds,
							chain: {
								policy: output.policy,
								applied: output.applied,
								held_task_id: output.held_task_id,
								source_task_id: output.source_task_id,
								source_kind: output.source_kind,
								implicit_dependency_ids: output.implicit_dependency_ids,
								final_dependency_ids: output.final_dependency_ids,
							},
						},
					});
					return output;
				})(),
			);
			return { ok: true, task: { id: taskId, status: "queued" }, chain: chainOutput };
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
					| { id: string; fencing_token: number; capability: Capability }
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
				task: {
					id: claimed.id,
					status: "claimed",
					token: claimed.fencing_token,
					capability: claimed.capability,
				},
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
	complete: ({ taskId, runId, token, resultJson }) =>
		withDb(ctx, (db) => {
			const actorRunId = resolveRunId(ctx, runId);
			liveRun(db, actorRunId);
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
				const affectedTask = taskDetail(db, taskId);
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
				createRepairAlertInTxn(ctx, db, {
					kind: "task_failed",
					affectedTaskId: taskId,
					escalationTitle: `Investigate failed task ${taskId}`,
					escalationBody: `Task ${taskId} failed while held by run ${actorRunId} (scope: ${affectedTask.scope_id}, capability: ${affectedTask.capability}, attempts: ${affectedTask.attempts}).\n\nReason: ${nonEmptyReason}\n\nInvestigate the task and decide whether to supersede, re-enqueue, or accept the failure.`,
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
			withCollisionGuard(artifactId, () =>
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
				})(),
			);
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
						sql`UPDATE tasks SET status='cancelled', completed_at=COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?`,
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
			const task = taskInspectTask(db, taskId);
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
			const { supersedes, superseded_by } = taskSupersessionLinks(db, taskId);
			const repairAlertRow = db
				.prepare(sql`SELECT kind FROM repair_alerts WHERE task_id=?`)
				.get(taskId) as { kind: string } | undefined;
			const repairAlertKind: RepairAlertKind | null =
				repairAlertRow !== undefined
					? decodeRow(
							RepairAlertKindSchema,
							repairAlertRow.kind,
							`repair_alerts.kind for task ${taskId}`,
						)
					: null;
			return {
				ok: true,
				task,
				dependencies,
				dependents,
				source: taskSourceSummary(db, taskId),
				lineage: taskLineage(db, taskId),
				supersedes,
				superseded_by,
				artifacts: taskArtifacts(db, taskId),
				repair_alert_kind: repairAlertKind,
			};
		}),
	graphInspect: ({ taskId, scope, all, hideTerminal }) =>
		withDb(ctx, (db) => {
			const selectorCount = [taskId, scope, all === true ? "all" : undefined].filter(
				(v) => v !== undefined,
			).length;
			if (selectorCount !== 1) fail("VALIDATION_ERROR", "provide exactly one graph selector");
			let result: GraphInspectOutput;
			if (taskId !== undefined) {
				result = graphForIds(db, { kind: "task", value: taskId }, [taskSummary(db, taskId).id]);
			} else if (scope !== undefined) {
				const scopeExists = db.prepare(sql`SELECT 1 FROM scopes WHERE id=?`).get(scope);
				if (scopeExists === undefined) fail("NOT_FOUND", `scope not found: ${scope}`);
				result = graphForIds(
					db,
					{ kind: "scope", value: scope },
					(
						db
							.prepare(sql`
								SELECT id
								FROM tasks
								WHERE scope_id=?
								  AND (status <> 'cancelled' OR completed_at > datetime('now', '-1 hour'))
							`)
							.all(scope) as { id: string }[]
					).map((r) => r.id),
				);
			} else {
				result = graphForIds(
					db,
					{ kind: "all" },
					(
						db
							.prepare(sql`
								SELECT id
								FROM tasks
								WHERE status <> 'cancelled' OR completed_at > datetime('now', '-1 hour')
							`)
							.all() as { id: string }[]
					).map((r) => r.id),
				);
			}
			if (!hideTerminal) return result;
			return { ...result, graph: filterTerminalLeaves(result.graph, taskId) };
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
			const recentlyCompleted = db
				.prepare(
					`${taskSummarySelect} WHERE t.status='done' AND t.completed_at > datetime('now', '-1 hour') ORDER BY t.completed_at DESC`,
				)
				.all()
				.map((row) => parseTaskSummary(row, "malformed recently completed task row"));
			return {
				ok: true,
				ready: visible.filter((t) => isClaimable(db, t)),
				blocked: visible
					.filter((t) => !isClaimable(db, t))
					.map((t) => {
						const blockers = unresolvedDependencies(db, t.id).map((id) => {
							const blocker = taskSummary(db, id);
							return {
								id: blocker.id,
								scope_id: blocker.scope_id,
								status: blocker.status,
								scope_description: blocker.scope_description,
							};
						});
						return { ...t, unresolved_dependency_ids: blockers.map((b) => b.id), blockers };
					}),
				recentlyCompleted,
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
			enforceTaskAdmissionScope(ctx, db, replacementScope, replacementCap);
			const replacementBody =
				body === undefined && bodyFile === undefined ? old.body : resolveBody(ctx, body, bodyFile);
			const replacementTitle = title ?? old.title;
			return withCollisionGuard(replacementId, () =>
				db.transaction(() => {
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
							sql`UPDATE tasks SET status='cancelled', completed_at=COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=?`,
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
				})(),
			);
		}),
	escalateLaunchPrecondition: ({
		runId,
		expectedTaskId,
		expectedScopeId,
		expectedCapability,
		canonicalPath,
		agentKind,
		reason,
		escalationTitle,
		escalationBody,
	}) =>
		withDb(ctx, (db) => {
			const actorRunId = resolveRunId(ctx, runId);
			const actorRun = liveRun(db, actorRunId);
			if (actorRun.agent_kind !== "pdx") {
				fail("VALIDATION_ERROR", "launch-precondition Repair Alert must be authored by pdx");
			}
			const agentExists = db
				.prepare(sql`SELECT 1 FROM agent_kinds WHERE agent_kind = ?`)
				.get(agentKind);
			if (agentExists === undefined) fail("VALIDATION_ERROR", `unknown agent kind: ${agentKind}`);
			scopeForCapability(db, "global", "escalate");
			const nonEmptyReason = requireNonEmpty(reason, "--reason");
			const title = requireNonEmpty(escalationTitle, "escalation title");
			const bodyText = requireNonEmpty(escalationBody, "escalation body");
			const expectedPath = requireNonEmpty(canonicalPath, "canonical path");
			const escalationId = Effect.runSync(ctx.services.ids.make("task"));
			return withCollisionGuard(escalationId, () =>
				db.transaction((): LaunchPreconditionEscalationOutput => {
					const task = taskSummary(db, expectedTaskId);
					if (task.status !== "queued") {
						fail("STALE_TOKEN_RACE", `launch precondition task is not queued: ${task.status}`);
					}
					if (task.scope_id !== expectedScopeId) {
						fail("STALE_TOKEN_RACE", "launch precondition task scope changed before cancel");
					}
					if (task.capability !== expectedCapability) {
						fail("STALE_TOKEN_RACE", "launch precondition task capability changed before cancel");
					}
					if (task.canonical_path !== expectedPath) {
						fail("STALE_TOKEN_RACE", "launch precondition scope path changed before cancel");
					}
					const holder = db
						.prepare(
							sql`SELECT id FROM runs WHERE task_id=? AND status NOT IN ('ended','failed','cancelled','timed_out')`,
						)
						.pluck()
						.get(expectedTaskId) as string | undefined;
					if (holder !== undefined) {
						fail("STALE_TOKEN_RACE", `launch precondition task is held by run: ${holder}`);
					}
					const cancelUpdate = db
						.prepare(
							sql`UPDATE tasks SET status='cancelled', completed_at=COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='queued'`,
						)
						.run(expectedTaskId);
					if (cancelUpdate.changes === 0) {
						fail("STALE_TOKEN_RACE", "launch precondition task changed before cancel");
					}
					db.prepare(
						sql`INSERT INTO tasks(id,scope_id,capability,title,body,created_by_run_id) VALUES (?,?,?,?,?,?)`,
					).run(escalationId, "global", "escalate", title, bodyText, actorRunId);
					insertTaskSource(db, escalationId, expectedTaskId, actorRunId, "repair_source");
					insertRepairAlert(db, escalationId, "launch_precondition");
					event(ctx, db, "task.cancelled", {
						task_id: expectedTaskId,
						actor_run_id: actorRunId,
						payload: {
							reason: nonEmptyReason,
							scope_id: expectedScopeId,
							capability: expectedCapability,
							canonical_path: expectedPath,
							agent_kind: agentKind,
							escalation_task_id: escalationId,
							source_kind: "repair_source",
						},
					});
					event(ctx, db, "task.created", {
						task_id: escalationId,
						actor_run_id: actorRunId,
						payload: {
							scope_id: "global",
							capability: "escalate",
							title,
							depends_on_task_ids: [],
							source_task_id: expectedTaskId,
							source_kind: "repair_source",
							reason: nonEmptyReason,
							launch_precondition: {
								task_id: expectedTaskId,
								scope_id: expectedScopeId,
								capability: expectedCapability,
								canonical_path: expectedPath,
								agent_kind: agentKind,
							},
						},
					});
					return {
						ok: true as const,
						task: { id: expectedTaskId, status: "cancelled" as const },
						escalation: {
							id: escalationId,
							status: "queued" as const,
							scope_id: "global" as const,
							capability: "escalate" as const,
							source_task_id: expectedTaskId,
							source_kind: "repair_source" as const,
						},
					};
				})(),
			);
		}),
	createRepairAlert: ({ runId, affectedTaskId, kind, escalationTitle, escalationBody }) =>
		withDb(ctx, (db) =>
			createRepairAlertTask(ctx, db, {
				actorRunId: resolveRunId(ctx, runId),
				affectedTaskId,
				kind,
				escalationTitle,
				escalationBody,
			}),
		),
	claimableRepairAlertKinds: () =>
		withDb(ctx, (db) => {
			const rows = db
				.prepare(
					sql`
					SELECT DISTINCT ra.kind
					FROM repair_alerts ra
					JOIN tasks t ON t.id = ra.task_id
					WHERE t.status = 'queued'
					  AND t.scope_id = 'global'
					  AND t.capability = 'escalate'
					  AND NOT EXISTS (
					    SELECT 1 FROM task_dependencies td
					    JOIN tasks dep ON dep.id = td.depends_on_task_id
					    WHERE td.task_id = t.id AND dep.status <> 'done'
					  )
				`,
				)
				.all() as { kind: string }[];
			const kinds = rows.map((r) => decodeRow(RepairAlertKindSchema, r.kind, "repair_alerts.kind"));
			return { ok: true as const, kinds };
		}),
});

const scopeForCapability = (db: Db, scopeId: string, cap: Capability): ScopeRow => {
	const s = scopeById(db, scopeId);
	enforceActiveScope(s);

	if (cap === "escalate" && s.kind !== "global") {
		fail("VALIDATION_ERROR", `escalate requires global scope; got ${scopeId}`);
	}

	if (cap === "intake" && s.kind !== "global") {
		fail("VALIDATION_ERROR", `intake requires global scope; got ${scopeId}`);
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

	return s;
};

const enforceTaskAdmissionScope = (
	ctx: EngineContext,
	db: Db,
	scopeId: string,
	cap: Capability,
): void => {
	const s = scopeForCapability(db, scopeId, cap);
	if (s.kind === "global") return;
	const canonicalPath =
		s.canonical_path ??
		fail("INTERNAL_ERROR", `${s.kind} scope ${scopeId} is missing canonical_path`);
	const existsDirectory = Effect.runSync(ctx.services.fs.existsDirectory(canonicalPath));
	if (!existsDirectory) {
		fail(
			"VALIDATION_ERROR",
			`${s.kind} scope path is missing or not a directory: ${canonicalPath}. Create or restore the directory, then run \`pithos scope upsert --kind ${s.kind} --path ${canonicalPath}\`.`,
		);
	}
};

export const enforceCapScope = (db: Db, scopeId: string, cap: Capability): void => {
	void scopeForCapability(db, scopeId, cap);
};

export { authorized, event };
