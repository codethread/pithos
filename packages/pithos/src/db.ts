import Database from "better-sqlite3";
import {
	BUILTIN_AGENT_CLAIMS,
	BUILTIN_AGENT_ENQUEUES,
	BUILTIN_AGENT_KINDS,
	BUILTIN_CAPABILITIES,
	type AgentKind,
	type Capability,
} from "./builtins.js";
import { decodeRow } from "./rows.js";

export type Db = Database.Database;
export type ScopeKind = "global" | "repo" | "worktree";
export type Mode = "afk" | "hitl";
export type HarnessKind = "claude" | "pi" | "system";
export type { AgentKind, Capability };

export type TaskStatus =
	| "queued"
	| "claimed"
	| "running"
	| "done"
	| "failed"
	| "dead_letter"
	| "cancelled";

export const openDb = (path: string): Db => new Database(path);

export const sql = (strings: TemplateStringsArray, ...values: readonly unknown[]): string =>
	String.raw({ raw: strings }, ...values);

export const migrate = (db: Db): void => {
	db.pragma("foreign_keys = ON");
	db.exec(sql`
CREATE TABLE IF NOT EXISTS scopes (
	id TEXT PRIMARY KEY CHECK (length(id) > 0),
	kind TEXT NOT NULL CHECK (kind IN ('global', 'repo', 'worktree')),
	canonical_path TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	archived_at TEXT,
	CHECK (
		(kind = 'global' AND canonical_path IS NULL)
		OR (kind <> 'global' AND canonical_path IS NOT NULL AND length(canonical_path) > 0)
	)
);

CREATE TABLE IF NOT EXISTS agent_kinds (
	agent_kind TEXT PRIMARY KEY,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS capabilities (
	capability TEXT PRIMARY KEY,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_claims (
	agent_kind TEXT NOT NULL REFERENCES agent_kinds(agent_kind),
	capability TEXT NOT NULL REFERENCES capabilities(capability),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (agent_kind, capability)
);

CREATE TABLE IF NOT EXISTS agent_enqueues (
	agent_kind TEXT NOT NULL REFERENCES agent_kinds(agent_kind),
	capability TEXT NOT NULL REFERENCES capabilities(capability),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (agent_kind, capability)
);

CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY CHECK (length(id) > 0),
	agent_kind TEXT NOT NULL REFERENCES agent_kinds(agent_kind),
	mode TEXT NOT NULL CHECK (mode IN ('afk', 'hitl')),
	scope_id TEXT NOT NULL REFERENCES scopes(id),
	cwd TEXT NOT NULL CHECK (length(cwd) > 0),
	session_id TEXT NOT NULL CHECK (length(session_id) > 0),
	harness_kind TEXT NOT NULL CHECK (harness_kind IN ('claude', 'pi', 'system')),
	session_log_path TEXT NOT NULL CHECK (length(session_log_path) > 0),
	status TEXT NOT NULL CHECK (status IN ('live', 'ended', 'failed', 'cancelled', 'timed_out')) DEFAULT 'live',
	task_id TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	scope_id TEXT NOT NULL REFERENCES scopes(id),
	capability TEXT NOT NULL REFERENCES capabilities(capability),
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	status TEXT NOT NULL CHECK (
		status IN (
			'queued',
			'claimed',
			'running',
			'done',
			'failed',
			'dead_letter',
			'cancelled'
		)
	) DEFAULT 'queued',
	fencing_token INTEGER NOT NULL DEFAULT 0,
	attempts INTEGER NOT NULL DEFAULT 0,
	max_attempts INTEGER NOT NULL DEFAULT 3,
	created_by_run_id TEXT NOT NULL REFERENCES runs(id),
	result_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	completed_at TEXT
);

CREATE TABLE IF NOT EXISTS task_dependencies (
	task_id TEXT NOT NULL REFERENCES tasks(id),
	depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (task_id, depends_on_task_id),
	CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS task_supersessions (
	old_task_id TEXT PRIMARY KEY REFERENCES tasks(id),
	new_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
	created_by_run_id TEXT REFERENCES runs(id),
	reason TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CHECK (old_task_id <> new_task_id)
);

CREATE TABLE IF NOT EXISTS task_sources (
	task_id TEXT PRIMARY KEY REFERENCES tasks(id),
	source_task_id TEXT NOT NULL REFERENCES tasks(id),
	source_run_id TEXT NOT NULL REFERENCES runs(id),
	kind TEXT NOT NULL CHECK (kind IN ('chain_source')),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CHECK (task_id <> source_task_id)
);

CREATE TABLE IF NOT EXISTS events (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	task_id TEXT,
	run_id TEXT,
	actor_run_id TEXT,
	payload_json TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS artifacts (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id),
	run_id TEXT NOT NULL REFERENCES runs(id),
	kind TEXT NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_task_id
	ON runs(task_id)
	WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_dependencies_task
	ON task_dependencies(task_id);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocker
	ON task_dependencies(depends_on_task_id);

CREATE INDEX IF NOT EXISTS idx_task_supersessions_new
	ON task_supersessions(new_task_id);

CREATE INDEX IF NOT EXISTS idx_task_sources_source
	ON task_sources(source_task_id);
`);
	ensureScopesArchivedAtColumn(db);
	seed(db);
};

const ensureScopesArchivedAtColumn = (db: Db): void => {
	const columns = db.prepare(sql`PRAGMA table_info(scopes)`).all() as { name: string }[];
	if (!columns.some((column) => column.name === "archived_at")) {
		db.exec(sql`ALTER TABLE scopes ADD COLUMN archived_at TEXT`);
	}
};

const seed = (db: Db): void => {
	db.prepare(sql`INSERT OR IGNORE INTO scopes (id, kind) VALUES ('global', 'global')`).run();

	for (const agent of BUILTIN_AGENT_KINDS) {
		db.prepare(sql`INSERT OR IGNORE INTO agent_kinds (agent_kind) VALUES (?)`).run(agent);
	}

	for (const cap of BUILTIN_CAPABILITIES) {
		db.prepare(sql`INSERT OR IGNORE INTO capabilities (capability) VALUES (?)`).run(cap);
	}

	for (const [a, caps] of Object.entries(BUILTIN_AGENT_CLAIMS)) {
		for (const c of caps) {
			db.prepare(
				sql`INSERT OR IGNORE INTO agent_claims (agent_kind, capability) VALUES (?, ?)`,
			).run(a, c);
		}
	}

	for (const [a, caps] of Object.entries(BUILTIN_AGENT_ENQUEUES)) {
		for (const c of caps) {
			db.prepare(
				sql`INSERT OR IGNORE INTO agent_enqueues (agent_kind, capability) VALUES (?, ?)`,
			).run(a, c);
		}
	}
};

export { decodeRow };
