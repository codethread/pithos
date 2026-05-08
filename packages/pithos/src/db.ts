import Database from "better-sqlite3"
import { fail } from "./errors.js"

export type Db = Database.Database
export type ScopeKind = "global" | "repo" | "worktree"
export type Mode = "afk" | "hitl"
export type AgentKind = "pdx" | "pandora" | "toil" | "greed" | "war"
export type Capability = "triage" | "design" | "execute" | "escalate"
export type TaskStatus = "queued" | "claimed" | "running" | "done" | "failed" | "dead_letter" | "cancelled"

export const openDb = (path: string): Db => new Database(path)

export const migrate = (db: Db): void => {
  db.pragma("foreign_keys = ON")
  db.exec(`
CREATE TABLE IF NOT EXISTS scopes (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('global','repo','worktree')), canonical_path TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK ((kind='global' AND canonical_path IS NULL) OR (kind <> 'global')));
CREATE TABLE IF NOT EXISTS agent_kinds (agent_kind TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS capabilities (capability TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS agent_claims (agent_kind TEXT NOT NULL REFERENCES agent_kinds(agent_kind), capability TEXT NOT NULL REFERENCES capabilities(capability), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(agent_kind, capability));
CREATE TABLE IF NOT EXISTS agent_enqueues (agent_kind TEXT NOT NULL REFERENCES agent_kinds(agent_kind), capability TEXT NOT NULL REFERENCES capabilities(capability), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(agent_kind, capability));
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, agent_kind TEXT NOT NULL REFERENCES agent_kinds(agent_kind), mode TEXT NOT NULL CHECK(mode IN ('afk','hitl')), scope_id TEXT NOT NULL REFERENCES scopes(id), cwd TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('live','ended','failed','cancelled','timed_out')) DEFAULT 'live', task_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id), capability TEXT NOT NULL REFERENCES capabilities(capability), title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','claimed','running','done','failed','dead_letter','cancelled')) DEFAULT 'queued', fencing_token INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, created_by_run_id TEXT NOT NULL REFERENCES runs(id), result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT);
CREATE TABLE IF NOT EXISTS task_dependencies (task_id TEXT NOT NULL REFERENCES tasks(id), depends_on_task_id TEXT NOT NULL REFERENCES tasks(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(task_id, depends_on_task_id), CHECK(task_id <> depends_on_task_id));
CREATE TABLE IF NOT EXISTS task_supersessions (old_task_id TEXT PRIMARY KEY REFERENCES tasks(id), new_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), created_by_run_id TEXT REFERENCES runs(id), reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK(old_task_id <> new_task_id));
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT NOT NULL, task_id TEXT, run_id TEXT, actor_run_id TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocker ON task_dependencies(depends_on_task_id);
CREATE INDEX IF NOT EXISTS idx_task_supersessions_new ON task_supersessions(new_task_id);
`)
  seed(db)
}

const seed = (db: Db): void => {
  db.prepare("INSERT OR IGNORE INTO scopes(id, kind) VALUES ('global','global')").run()
  for (const agent of ["pdx", "pandora", "toil", "greed", "war"]) db.prepare("INSERT OR IGNORE INTO agent_kinds(agent_kind) VALUES (?)").run(agent)
  for (const cap of ["triage", "design", "execute", "escalate"]) db.prepare("INSERT OR IGNORE INTO capabilities(capability) VALUES (?)").run(cap)
  for (const [a, c] of [["pandora","escalate"],["toil","triage"],["greed","design"],["war","execute"]]) db.prepare("INSERT OR IGNORE INTO agent_claims(agent_kind, capability) VALUES (?,?)").run(a, c)
  for (const [a, caps] of Object.entries({ pdx:["escalate"], pandora:["triage","design","escalate"], toil:["triage","design","execute","escalate"], greed:["triage","design","escalate"], war:["escalate"] })) for (const c of caps) db.prepare("INSERT OR IGNORE INTO agent_enqueues(agent_kind, capability) VALUES (?,?)").run(a, c)
}

export const row = <T extends object>(value: unknown, message: string): T => {
  if (value === undefined) fail("NOT_FOUND", message)
  if (value === null || typeof value !== "object") fail("INTERNAL_ERROR", `invalid database row: ${message}`)
  return value as T
}
