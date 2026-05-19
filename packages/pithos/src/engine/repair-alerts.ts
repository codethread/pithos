import { Effect } from "effect";
import { sql, type Capability } from "../db.js";
import type { Db } from "../db.js";
import { fail } from "../errors.js";
import {
	decodeRow,
	RepairAlertKindSchema,
	type RepairAlertKind,
	type RunRow,
	type ScopeRow,
} from "../rows.js";
import { withCollisionGuard, withDb } from "./db-helpers.js";
import { event } from "./event-log.js";
import { insertTaskSource, taskSummary } from "./task-read-model.js";
import {
	PDX_SYSTEM_RUN_ID,
	type Engine,
	type EngineContext,
	type LaunchPreconditionEscalationOutput,
	type RepairAlertOutput,
} from "./types.js";

export interface RepairAlertDeps {
	readonly requireNonEmpty: (value: string, name: string) => string;
	readonly resolveRunId: (ctx: EngineContext, explicit: string | undefined) => string;
	readonly liveRun: (db: Db, runId: string) => RunRow;
	readonly scopeForCapability: (db: Db, scopeId: string, cap: Capability) => ScopeRow;
}

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

/**
 * Creates the Repair Alert task inside the caller's existing transition transaction.
 * Lifecycle transitions own the trigger decision; this helper owns the shared
 * alert task, repair_alerts row, repair_source provenance, and event write.
 */
export const createRepairAlertInTxn = (
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
	withCollisionGuard(alertId, () => {
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
	});
};

const createRepairAlertTask = (
	ctx: EngineContext,
	deps: RepairAlertDeps,
	db: Db,
	input: {
		readonly actorRunId: string;
		readonly affectedTaskId: string | undefined;
		readonly kind: RepairAlertKind;
		readonly escalationTitle: string;
		readonly escalationBody: string;
	},
): RepairAlertOutput => {
	const actorRun = deps.liveRun(db, input.actorRunId);
	if (actorRun.agent_kind !== "pdx") {
		fail("VALIDATION_ERROR", "repair alert must be authored by pdx");
	}
	deps.scopeForCapability(db, "global", "escalate");
	const affectedTask =
		input.affectedTaskId !== undefined ? taskSummary(db, input.affectedTaskId) : undefined;
	const title = deps.requireNonEmpty(input.escalationTitle, "escalation title");
	const bodyText = deps.requireNonEmpty(input.escalationBody, "escalation body");
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

export const makeRepairAlertOps = (
	ctx: EngineContext,
	deps: RepairAlertDeps,
): Pick<
	Engine,
	"escalateLaunchPrecondition" | "createRepairAlert" | "claimableRepairAlertKinds"
> => ({
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
			const actorRunId = deps.resolveRunId(ctx, runId);
			const actorRun = deps.liveRun(db, actorRunId);
			if (actorRun.agent_kind !== "pdx") {
				fail("VALIDATION_ERROR", "launch-precondition Repair Alert must be authored by pdx");
			}
			const agentExists = db
				.prepare(sql`SELECT 1 FROM agent_kinds WHERE agent_kind = ?`)
				.get(agentKind);
			if (agentExists === undefined) fail("VALIDATION_ERROR", `unknown agent kind: ${agentKind}`);
			deps.scopeForCapability(db, "global", "escalate");
			const nonEmptyReason = deps.requireNonEmpty(reason, "--reason");
			const title = deps.requireNonEmpty(escalationTitle, "escalation title");
			const bodyText = deps.requireNonEmpty(escalationBody, "escalation body");
			const expectedPath = deps.requireNonEmpty(canonicalPath, "canonical path");
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
			createRepairAlertTask(ctx, deps, db, {
				actorRunId: deps.resolveRunId(ctx, runId),
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
