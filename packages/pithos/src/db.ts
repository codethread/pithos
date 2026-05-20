import Database from "better-sqlite3";
import {
	BUILTIN_AGENT_CLAIMS,
	BUILTIN_AGENT_ENQUEUES,
	BUILTIN_AGENT_KINDS,
	BUILTIN_CAPABILITIES,
	type AgentKind,
	type Capability,
} from "./builtins.js";
import { REPAIR_ALERT_KINDS, decodeRow } from "./rows.js";

export type Db = Database.Database;
export type ScopeKind = "global" | "repo" | "worktree";
export type Mode = "afk" | "hitl";
export type HarnessKind = "claude" | "pi" | "system";
export type EdgeKind = "after" | "about" | "repair" | "gate";
export type SourceKind = "chain_source" | "repair_source";
export type { AgentKind, Capability };

export const TASK_STATUSES = [
	"queued",
	"claimed",
	"running",
	"done",
	"failed",
	"dead_letter",
	"cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const openDb = (path: string): Db => new Database(path);

export const sql = (strings: TemplateStringsArray, ...values: readonly unknown[]): string =>
	String.raw({ raw: strings }, ...values);

const repairAlertKindListSql = REPAIR_ALERT_KINDS.map((kind) => `\t\t'${kind}'`).join(",\n");

const repairAlertsTableSql = (tableName: string): string => sql`
CREATE TABLE ${tableName} (
	task_id    TEXT PRIMARY KEY REFERENCES tasks(id),
	kind       TEXT NOT NULL CHECK (kind IN (
${repairAlertKindListSql}
	)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export const migrate = (db: Db): void => {
	db.pragma("foreign_keys = ON");
	db.exec(sql`
CREATE TABLE IF NOT EXISTS scopes (
	id TEXT PRIMARY KEY CHECK (length(id) > 0),
	kind TEXT NOT NULL CHECK (kind IN ('global', 'repo', 'worktree')),
	canonical_path TEXT,
	parent_repo_path TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	archived_at TEXT,
	CHECK (
		(kind = 'global' AND canonical_path IS NULL AND parent_repo_path IS NULL)
		OR (kind = 'repo' AND canonical_path IS NOT NULL AND length(canonical_path) > 0 AND parent_repo_path IS NULL)
		OR (kind = 'worktree' AND canonical_path IS NOT NULL AND length(canonical_path) > 0 AND parent_repo_path IS NOT NULL AND length(parent_repo_path) > 0)
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
	has_claimed_task INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS task_edges (
	task_id TEXT NOT NULL REFERENCES tasks(id),
	target_task_id TEXT NOT NULL REFERENCES tasks(id),
	kind TEXT NOT NULL CHECK (kind IN ('after', 'gate', 'about', 'repair')),
	created_by_run_id TEXT NOT NULL REFERENCES runs(id),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (task_id, target_task_id, kind),
	CHECK (task_id <> target_task_id)
);

CREATE TABLE IF NOT EXISTS task_supersessions (
	old_task_id TEXT PRIMARY KEY REFERENCES tasks(id),
	new_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
	created_by_run_id TEXT REFERENCES runs(id),
	reason TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CHECK (old_task_id <> new_task_id)
);

CREATE TABLE IF NOT EXISTS task_gate_releases (
	task_id TEXT NOT NULL REFERENCES tasks(id),
	target_task_id TEXT NOT NULL REFERENCES tasks(id),
	attempt INTEGER NOT NULL,
	fencing_token INTEGER NOT NULL,
	released_by_run_id TEXT NOT NULL REFERENCES runs(id),
	released_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (task_id, target_task_id, attempt)
);

CREATE TABLE IF NOT EXISTS task_gate_release_members (
	task_id TEXT NOT NULL,
	target_task_id TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	member_task_id TEXT NOT NULL REFERENCES tasks(id),
	canonical_task_id TEXT NOT NULL REFERENCES tasks(id),
	status_at_release TEXT NOT NULL,
	PRIMARY KEY (task_id, target_task_id, attempt, member_task_id),
	FOREIGN KEY (task_id, target_task_id, attempt)
		REFERENCES task_gate_releases(task_id, target_task_id, attempt)
);

CREATE TABLE IF NOT EXISTS task_gate_late_growth_markers (
	id TEXT PRIMARY KEY,
	gate_task_id TEXT NOT NULL,
	gate_target_task_id TEXT NOT NULL,
	gate_attempt INTEGER NOT NULL,
	mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('edge_inserted', 'supersession')),
	edge_task_id TEXT REFERENCES tasks(id),
	edge_target_task_id TEXT REFERENCES tasks(id),
	edge_kind TEXT CHECK (edge_kind IN ('after', 'about', 'repair')),
	superseded_task_id TEXT REFERENCES tasks(id),
	replacement_task_id TEXT REFERENCES tasks(id),
	created_by_run_id TEXT NOT NULL REFERENCES runs(id),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (gate_task_id, gate_target_task_id, gate_attempt)
		REFERENCES task_gate_releases(task_id, target_task_id, attempt),
	CHECK (
		(mutation_kind = 'edge_inserted'
			AND edge_task_id IS NOT NULL
			AND edge_target_task_id IS NOT NULL
			AND edge_kind IS NOT NULL
			AND superseded_task_id IS NULL
			AND replacement_task_id IS NULL)
		OR (mutation_kind = 'supersession'
			AND edge_task_id IS NULL
			AND edge_target_task_id IS NULL
			AND edge_kind IS NULL
			AND superseded_task_id IS NOT NULL
			AND replacement_task_id IS NOT NULL)
	)
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

${repairAlertsTableSql("IF NOT EXISTS repair_alerts")}

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_task_id
	ON runs(task_id)
	WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_edges_task_kind
	ON task_edges(task_id, kind);

CREATE INDEX IF NOT EXISTS idx_task_edges_target_kind
	ON task_edges(target_task_id, kind);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_edges_one_attention_anchor
	ON task_edges(task_id)
	WHERE kind IN ('about', 'repair');

CREATE INDEX IF NOT EXISTS idx_task_supersessions_new
	ON task_supersessions(new_task_id);

CREATE INDEX IF NOT EXISTS idx_events_created_at
	ON events(created_at);

CREATE INDEX IF NOT EXISTS idx_events_type_created_at
	ON events(type, created_at);
`);
	ensureScopesArchivedAtColumn(db);
	ensureScopesDescriptionColumn(db);
	ensureScopesParentRepoPathColumn(db);
	ensureRunsHasClaimedTaskColumn(db);
	ensureRepairAlertsKindConstraint(db);
	seed(db);
};

const ensureScopesArchivedAtColumn = (db: Db): void => {
	const columns = db.prepare(sql`PRAGMA table_info(scopes)`).all() as { name: string }[];
	if (!columns.some((column) => column.name === "archived_at")) {
		db.exec(sql`ALTER TABLE scopes ADD COLUMN archived_at TEXT`);
	}
};

const ensureScopesDescriptionColumn = (db: Db): void => {
	const columns = db.prepare(sql`PRAGMA table_info(scopes)`).all() as { name: string }[];
	if (!columns.some((column) => column.name === "description")) {
		db.exec(sql`ALTER TABLE scopes ADD COLUMN description TEXT`);
	}
};

const ensureScopesParentRepoPathColumn = (db: Db): void => {
	const columns = db.prepare(sql`PRAGMA table_info(scopes)`).all() as { name: string }[];
	if (!columns.some((column) => column.name === "parent_repo_path")) {
		db.exec(sql`ALTER TABLE scopes ADD COLUMN parent_repo_path TEXT`);
	}
};

const ensureRunsHasClaimedTaskColumn = (db: Db): void => {
	const columns = db.prepare(sql`PRAGMA table_info(runs)`).all() as { name: string }[];
	if (!columns.some((column) => column.name === "has_claimed_task")) {
		db.exec(sql`ALTER TABLE runs ADD COLUMN has_claimed_task INTEGER NOT NULL DEFAULT 0`);
	}
};

// SQLite CHECK constraints cannot be altered in place; rebuild the table when
// existing DB DDL is missing any current Repair Alert kind.
const ensureRepairAlertsKindConstraint = (db: Db): void => {
	const rows = db
		.prepare(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='repair_alerts'`)
		.all() as { sql: string }[];
	if (rows.length === 0) return;
	const tableSql = rows[0]?.sql ?? "";
	const hasAllKinds = REPAIR_ALERT_KINDS.every((kind) => tableSql.includes(`'${kind}'`));
	if (hasAllKinds) return;

	db.pragma("foreign_keys = OFF");
	try {
		db.transaction(() => {
			db.prepare(repairAlertsTableSql("repair_alerts_new")).run();
			db.prepare(sql`INSERT INTO repair_alerts_new SELECT * FROM repair_alerts`).run();
			db.prepare(sql`DROP TABLE repair_alerts`).run();
			db.prepare(sql`ALTER TABLE repair_alerts_new RENAME TO repair_alerts`).run();
		})();
	} finally {
		db.pragma("foreign_keys = ON");
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
