import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import {
	migrate,
	openDb,
	sql,
	type AgentKind,
	type Capability,
	type Mode,
	type ScopeKind,
} from "./db.js";
import { fail } from "./errors.js";
import { decodeRow, RunRowSchema, ScopeRowSchema, type RunRow } from "./rows.js";
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
		readonly agent: AgentKind;
		readonly mode: Mode;
		readonly scope: string;
		readonly cwd: string;
		readonly sessionId: string;
		readonly runId: string | undefined;
	}) => { readonly ok: true; readonly run: Record<string, unknown> };
	readonly claim: (input: {
		readonly runId: string;
		readonly scope: string;
		readonly capability: Capability;
	}) => {
		readonly ok: true;
		readonly task: { readonly id: string; readonly status: "claimed"; readonly token: number };
	};
}

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
	session_id
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id)
DO UPDATE SET
	agent_kind = excluded.agent_kind,
	mode = excluded.mode,
	scope_id = excluded.scope_id,
	cwd = excluded.cwd,
	session_id = excluded.session_id,
	updated_at = CURRENT_TIMESTAMP
`;

const event = (
	ctx: EngineContext,
	db: Db,
	type: string,
	payload: { task_id?: string; run_id?: string; actor_run_id?: string; payload: unknown },
): void => {
	db.prepare(eventPayload).run(
		ctx.services.ids.make("event"),
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

const authorized = (
	db: Db,
	table: "agent_claims" | "agent_enqueues",
	runId: string,
	cap: Capability,
): RunRow => {
	const r = decodeRow(
		RunRowSchema,
		db
			.prepare(
				sql`SELECT id,agent_kind,mode,scope_id,status,task_id,session_id,created_at,updated_at FROM runs WHERE id=?`,
			)
			.get(runId),
		`run not found: ${runId}`,
	);

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

export const makeEngine = (ctx: EngineContext): Engine => ({
	init: ({ fresh }) => {
		if (fresh) ctx.services.fs.removeFile(ctx.config.dbPath);
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
				kind === "global" ? undefined : (path ?? fail("VALIDATION_ERROR", "missing --path"));
			const canonical = rawPath === undefined ? null : resolve(rawPath);
			const sid = kind === "global" ? "global" : `${kind}:${canonical}`;

			db.prepare(upsertScope).run(sid, kind, canonical);
			return { ok: true, scope: { id: sid, kind, canonical_path: canonical } };
		}),
	runUpsert: ({ agent, mode, scope, cwd, sessionId, runId }) =>
		withDb(ctx, (db) => {
			const rid = runId ?? ctx.services.ids.make("run");
			db.prepare(upsertRun).run(rid, agent, mode, scope, cwd, sessionId);
			return {
				ok: true,
				run: {
					id: rid,
					agent,
					mode,
					scope_id: scope,
					status: "live",
					task_id: null,
					session_id: sessionId,
				},
			};
		}),
	claim: ({ runId, scope, capability }) =>
		withDb(ctx, (db) => {
			const r = authorized(db, "agent_claims", runId, capability);
			if (r.scope_id !== scope)
				fail("VALIDATION_ERROR", `claim scope ${scope} does not match run scope ${r.scope_id}`);

			const claimed = db.transaction(() => {
				const candidate = db.prepare(claimableTaskQuery).get(scope, capability) as
					| { id: string }
					| undefined;
				const task = candidate ?? fail("NO_CLAIMABLE_WORK", "no claimable work");

				const runRow = db.prepare(claimRunTaskUpdate).run(task.id, runId);
				if (runRow.changes === 0) fail("VALIDATION_ERROR", "run already holds a task");

				const updated = db.prepare(claimTaskUpdate).get(task.id) as
					| { id: string; fencing_token: number }
					| undefined;

				const claimedTask =
					updated ?? fail("STALE_TOKEN_RACE", "claim candidate changed before update");
				event(ctx, db, "task.claimed", {
					task_id: claimedTask.id,
					actor_run_id: runId,
					payload: { run_id: runId, fencing_token: claimedTask.fencing_token },
				});
				return claimedTask;
			})();

			return {
				ok: true,
				task: { id: claimed.id, status: "claimed", token: claimed.fencing_token },
			};
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
