import { Effect, Either, Schema } from "effect";
import { resolve } from "node:path";
import { finalDependencyIds, resolveChainPolicy } from "./chain-policy.js";
import type { Db } from "./db.js";
import { migrate, openDb, sql, type Capability, type HarnessKind } from "./db.js";
import { fail } from "./errors.js";
import {
	decodeRow,
	RepairAlertKindSchema,
	RunRowSchema,
	ScopeRowSchema,
	TaskRowSchema,
	type RepairAlertKind,
	type RunRow,
	type ScopeRow,
} from "./rows.js";
import { withCollisionGuard, withDb } from "./engine/db-helpers.js";
import { event, eventsTail, pruneEvents } from "./engine/event-log.js";
import { inspectGraph } from "./engine/graph-inspect.js";
import { createRepairAlertInTxn, makeRepairAlertOps } from "./engine/repair-alerts.js";
import {
	insertTaskSource,
	isClaimable,
	parseScopeArchiveCheck,
	parseScopeIdentity,
	parseScopeOutput,
	parseTaskDetail,
	parseTaskSummary,
	taskArtifacts,
	taskDetail,
	taskInspectTask,
	taskLineage,
	taskSourceEdge,
	taskSourceSummary,
	taskSummary,
	taskSummarySelect,
	taskSupersessionLinks,
	toScopeOutput,
	type TaskSummary,
	unresolvedDependencies,
	validateReferenceTaskCurrent,
} from "./engine/task-read-model.js";
export { parseGraphSinceCutoff } from "./engine/graph-inspect.js";
export {
	renderBriefingText,
	renderGraphInspectText,
	renderTaskInspectMarkdown,
} from "./engine/render.js";
export { PDX_SYSTEM_RUN_ID } from "./engine/types.js";
import type { ChainOutput, Engine, EngineContext, RunOutput, ScopeOutput } from "./engine/types.js";
export type {
	ArtifactOutput,
	BlockerOutput,
	BlockedTaskOutput,
	BriefingOutput,
	ChainOutput,
	Engine,
	EngineContext,
	EnqueueOutput,
	EventOutput,
	GraphEdgeOutput,
	GraphInspectOutput,
	GraphNodeOutput,
	GraphSelectorOutput,
	GraphSinceCutoff,
	Json,
	LaunchPreconditionEscalationOutput,
	LineageEntryOutput,
	RepairAlertOutput,
	RunOutput,
	ScopeIdentityOutput,
	ScopeOutput,
	SupersedeOutput,
	TaskDetailOutput,
	TaskInspectOutput,
	TaskInspectTaskOutput,
	TaskSourceSummaryOutput,
	TaskSummaryOutput,
} from "./engine/types.js";

const toRunOutput = (row: RunRow): RunOutput => ({
	id: row.id,
	agent: row.agent_kind,
	mode: row.mode,
	scope_id: row.scope_id,
	status: row.status,
	task_id: row.task_id,
	has_claimed_task: row.has_claimed_task === 1,
	session_id: row.session_id,
	harness_kind: row.harness_kind,
	session_log_path: row.session_log_path,
	created_at: row.created_at,
	updated_at: row.updated_at,
});

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
    has_claimed_task = 1,
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
	canonical_path,
	parent_repo_path
) VALUES (?, ?, ?, ?)
ON CONFLICT(id)
DO UPDATE SET
	kind = excluded.kind,
	canonical_path = excluded.canonical_path,
	parent_repo_path = excluded.parent_repo_path,
	archived_at = NULL,
	updated_at = CURRENT_TIMESTAMP
RETURNING id, kind, canonical_path, parent_repo_path, archived_at, description
`;

// Used when --description is explicitly provided: sets or clears the description.
const upsertScopeSetDescription = sql`
INSERT INTO scopes(
	id,
	kind,
	canonical_path,
	parent_repo_path,
	description
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id)
DO UPDATE SET
	kind = excluded.kind,
	canonical_path = excluded.canonical_path,
	parent_repo_path = excluded.parent_repo_path,
	description = excluded.description,
	archived_at = NULL,
	updated_at = CURRENT_TIMESTAMP
RETURNING id, kind, canonical_path, parent_repo_path, archived_at, description
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
	status = 'live',
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
	has_claimed_task,
	session_id,
	created_at,
	updated_at
FROM runs
`;

const scopeSelect = sql`
SELECT id, kind, canonical_path, parent_repo_path, archived_at, description
FROM scopes
`;

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
	scopeUpsert: ({ kind, path, parentRepoPath, description }) =>
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
			const canonicalParentRepoPath =
				kind === "worktree"
					? resolve(
							requireNonEmpty(
								parentRepoPath ??
									fail("VALIDATION_ERROR", "missing --parent-repo for worktree scope"),
								"--parent-repo",
							),
						)
					: parentRepoPath === undefined
						? null
						: fail(
								"VALIDATION_ERROR",
								`--parent-repo is only valid for worktree scope upsert; got ${kind}`,
							);
			if (kind === "worktree") {
				const worktreeParentRepoPath =
					canonicalParentRepoPath ?? fail("INTERNAL_ERROR", "missing worktree parent repo path");
				const existsDirectory = Effect.runSync(
					ctx.services.fs.existsDirectory(worktreeParentRepoPath),
				);
				if (!existsDirectory) {
					fail(
						"VALIDATION_ERROR",
						`worktree parent repo path must exist as a directory before upsert: ${worktreeParentRepoPath}. Create or restore the parent repo directory first, then upsert the scope.`,
					);
				}
			}
			const sid = kind === "global" ? "global" : `${kind}:${canonical}`;
			const scopeRow = parseScopeIdentity(
				description !== undefined
					? db
							.prepare(upsertScopeSetDescription)
							.get(sid, kind, canonical, canonicalParentRepoPath, description)
					: db
							.prepare(upsertScopePreserveDescription)
							.get(sid, kind, canonical, canonicalParentRepoPath),
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
						s.parent_repo_path,
						s.archived_at,
						s.description,
						COUNT(DISTINCT t.id) AS task_count,
						COUNT(DISTINCT r.id) AS run_count
					FROM scopes s
					LEFT JOIN tasks t ON t.scope_id = s.id
					LEFT JOIN runs r ON r.scope_id = s.id
					${all ? "" : "WHERE s.archived_at IS NULL"}
					GROUP BY s.id, s.kind, s.canonical_path, s.parent_repo_path, s.archived_at, s.description
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
							s.parent_repo_path,
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
						GROUP BY s.id, s.kind, s.canonical_path, s.parent_repo_path, s.archived_at, s.description
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
								sql`UPDATE scopes SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, kind, canonical_path, parent_repo_path, archived_at, description`,
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
				if (run.has_claimed_task !== 0) {
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
				if (run.has_claimed_task !== 0) {
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
	eventsTail: ({ limit }) => eventsTail(ctx, limit),
	pruneEvents: (input) => pruneEvents(ctx, input),
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
	graphInspect: ({ taskId, scope, all, status = [], search = [], sinceCutoff }) =>
		withDb(ctx, (db) => inspectGraph(db, { taskId, scope, all, status, search, sinceCutoff })),
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
	...makeRepairAlertOps(ctx, {
		requireNonEmpty,
		resolveRunId,
		liveRun,
		scopeForCapability,
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
	if (cap === "execute" && s.kind === "worktree" && s.parent_repo_path === null) {
		fail(
			"VALIDATION_ERROR",
			`execute requires worktree scope with parent_repo_path; got ${scopeId}`,
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
