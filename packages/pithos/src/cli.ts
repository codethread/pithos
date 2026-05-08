import crypto from "node:crypto"
import { resolve } from "node:path"
import type { Config } from "./config.js"
import type { Db } from "./db.js"
import { migrate, openDb, row, type AgentKind, type Capability, type Mode, type ScopeKind, type TaskStatus } from "./db.js"
import { fail, PithosError } from "./errors.js"
import type { Services } from "./services.js"

const id = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
const json = (value: unknown): string => `${JSON.stringify(value)}\n`

interface Ctx { readonly config: Config; readonly services: Services }

interface RunRow { id: string; agent_kind: AgentKind; mode: Mode; scope_id: string; status: string; task_id: string | null; session_id: string; created_at: string; updated_at: string }
interface TaskRow { id: string; scope_id: string; capability: Capability; title: string; body: string; status: TaskStatus; fencing_token: number; attempts: number; max_attempts: number; created_at: string }
interface ScopeRow { id: string; kind: ScopeKind; canonical_path: string | null }

const parseFlag = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const v = args[i + 1]
  if (v === undefined || v.startsWith("--")) fail("VALIDATION_ERROR", `missing value for ${name}`)
  return v
}
const allFlags = (args: readonly string[], name: string): readonly string[] => args.flatMap((a, i) => a === name && args[i + 1] !== undefined ? [args[i + 1]!] : [])
const req = (args: readonly string[], name: string): string => parseFlag(args, name) ?? fail("VALIDATION_ERROR", `missing ${name}`)
const resolvedRun = (ctx: Ctx, args: readonly string[]): string => {
  const explicit = parseFlag(args, "--run")
  const env = ctx.config.runId
  if (explicit !== undefined && env !== undefined && explicit !== env) fail("VALIDATION_ERROR", "--run conflicts with PITHOS_RUN_ID")
  return explicit ?? env ?? fail("VALIDATION_ERROR", "missing --run or PITHOS_RUN_ID")
}
const body = (ctx: Ctx, args: readonly string[]): string => {
  const inline = parseFlag(args, "--body")
  const file = parseFlag(args, "--body-file")
  if ((inline === undefined) === (file === undefined)) fail("VALIDATION_ERROR", "supply exactly one of --body or --body-file")
  const text = inline ?? ctx.services.fs.readText(file!)
  if (text.trim() === "") fail("VALIDATION_ERROR", "body must be non-empty")
  return text
}
const capability = (value: string): Capability => ["triage","design","execute","escalate"].includes(value) ? value as Capability : fail("VALIDATION_ERROR", `invalid capability: ${value}`)
const mode = (value: string): Mode => value === "afk" || value === "hitl" ? value : fail("VALIDATION_ERROR", `invalid mode: ${value}`)
const agent = (value: string): AgentKind => ["pdx","pandora","toil","greed","war"].includes(value) ? value as AgentKind : fail("VALIDATION_ERROR", `invalid agent: ${value}`)

const event = (db: Db, type: string, payload: { task_id?: string; run_id?: string; actor_run_id?: string; payload: unknown }): void => {
  db.prepare("INSERT INTO events(id,type,task_id,run_id,actor_run_id,payload_json) VALUES (?,?,?,?,?,?)").run(id("event"), type, payload.task_id ?? null, payload.run_id ?? null, payload.actor_run_id ?? null, JSON.stringify(payload.payload))
}
const enforceCapScope = (db: Db, scopeId: string, cap: Capability): void => {
  const s = row<ScopeRow>(db.prepare("SELECT id,kind,canonical_path FROM scopes WHERE id=?").get(scopeId), `scope not found: ${scopeId}`)
  if (cap === "escalate" && s.kind !== "global") fail("VALIDATION_ERROR", `escalate requires global scope; got ${scopeId}`)
  if (cap === "execute" && !((s.kind === "repo" || s.kind === "worktree") && s.canonical_path !== null)) fail("VALIDATION_ERROR", `execute requires repo/worktree scope with canonical_path; got ${scopeId} kind=${s.kind}`)
}
const authorized = (db: Db, table: "agent_claims" | "agent_enqueues", runId: string, cap: Capability): RunRow => {
  const r = row<RunRow>(db.prepare("SELECT id,agent_kind,mode,scope_id,status,task_id,session_id,created_at,updated_at FROM runs WHERE id=?").get(runId), `run not found: ${runId}`)
  const ok = db.prepare(`SELECT 1 FROM ${table} WHERE agent_kind=? AND capability=?`).get(r.agent_kind, cap)
  if (ok === undefined) fail("VALIDATION_ERROR", `${r.agent_kind} is not authorized for ${cap}`)
  return r
}

export const runCli = (ctx: Ctx, argv: readonly string[]): number => {
  try {
    const db = openDb(ctx.config.dbPath)
    const out = (v: unknown) => ctx.services.output.write(json(v))
    const [a, b, c, ...rest] = argv
    if (a === "init") { if (rest.includes("--fresh")) ctx.services.fs.removeFile(ctx.config.dbPath); migrate(db); out({ ok: true }); return 0 }
    migrate(db)
    if (a === "scope" && b === "upsert") { const kind = req(rest,"--kind") as ScopeKind; if (!["global","repo","worktree"].includes(kind)) fail("VALIDATION_ERROR", `invalid scope kind: ${kind}`); const rawPath = kind === "global" ? undefined : req(rest,"--path"); const canonical = rawPath === undefined ? null : resolve(rawPath); const sid = kind === "global" ? "global" : `${kind}:${canonical}`; db.prepare("INSERT INTO scopes(id,kind,canonical_path) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, canonical_path=excluded.canonical_path, updated_at=CURRENT_TIMESTAMP").run(sid, kind, canonical); out({ ok:true, scope:{ id:sid, kind, canonical_path: canonical } }); return 0 }
    if (a === "run" && b === "upsert") { const rid = parseFlag(rest,"--run") ?? id("run"); const ag = agent(req(rest,"--agent")); const mo = mode(req(rest,"--mode")); const scope = req(rest,"--scope"); const cwd = req(rest,"--cwd"); const sess = req(rest,"--session-id"); db.prepare("INSERT INTO runs(id,agent_kind,mode,scope_id,cwd,session_id) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent_kind=excluded.agent_kind, mode=excluded.mode, scope_id=excluded.scope_id, cwd=excluded.cwd, session_id=excluded.session_id, updated_at=CURRENT_TIMESTAMP").run(rid, ag, mo, scope, cwd, sess); out({ ok:true, run:{ id:rid, agent:ag, mode:mo, scope_id:scope, status:"live", task_id:null, session_id:sess } }); return 0 }
    if (a === "run" && b === "inspect") { const r = row<RunRow>(db.prepare("SELECT id,agent_kind,mode,scope_id,status,task_id,session_id,created_at,updated_at FROM runs WHERE id=?").get(c), `run not found: ${c}`); out({ ok:true, run:{ id:r.id, agent:r.agent_kind, mode:r.mode, scope_id:r.scope_id, status:r.status, task_id:r.task_id, session_id:r.session_id, created_at:r.created_at, updated_at:r.updated_at } }); return 0 }
    if (a === "task" && b === "enqueue") { const runId = resolvedRun(ctx, rest); const scope = req(rest,"--scope"); const cap = capability(req(rest,"--capability")); const title = req(rest,"--title"); const depends = allFlags(rest,"--depends-on"); if (new Set(depends).size !== depends.length) fail("VALIDATION_ERROR", "duplicate --depends-on"); enforceCapScope(db, scope, cap); authorized(db, "agent_enqueues", runId, cap); const tid = id("task"); db.transaction(() => { db.prepare("INSERT INTO tasks(id,scope_id,capability,title,body,created_by_run_id) VALUES (?,?,?,?,?,?)").run(tid, scope, cap, title, body(ctx, rest), runId); for (const dep of depends) { row<TaskRow>(db.prepare("SELECT id,scope_id,capability,title,body,status,fencing_token,attempts,max_attempts,created_at FROM tasks WHERE id=?").get(dep), `dependency not found: ${dep}`); if (db.prepare("SELECT new_task_id FROM task_supersessions WHERE old_task_id=?").get(dep) !== undefined) fail("VALIDATION_ERROR", `dependency has been superseded: ${dep}`); db.prepare("INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES (?,?)").run(tid, dep) } event(db,"task.created",{ task_id:tid, actor_run_id:runId, payload:{ scope_id:scope, capability:cap, title, depends_on_task_ids:depends } }) })(); out({ ok:true, task:{ id:tid, status:"queued", scope_id:scope, capability:cap } }); return 0 }
    if (a === "task" && b === "claim") { const runId = req(rest,"--run"); const scope = req(rest,"--scope"); const cap = capability(req(rest,"--capability")); const r = authorized(db,"agent_claims",runId,cap); if (r.scope_id !== scope) fail("VALIDATION_ERROR", `claim scope ${scope} does not match run scope ${r.scope_id}`); const t = row<{id:string}>(db.prepare("SELECT id FROM tasks t WHERE t.status='queued' AND t.scope_id=? AND t.capability=? AND NOT EXISTS (SELECT 1 FROM task_dependencies td JOIN tasks dep ON dep.id=td.depends_on_task_id WHERE td.task_id=t.id AND dep.status <> 'done') ORDER BY t.created_at ASC, t.id ASC LIMIT 1").get(scope, cap), "no claimable work"); db.transaction(() => { const rr = db.prepare("UPDATE runs SET task_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND task_id IS NULL").run(t.id, runId); if (rr.changes === 0) fail("VALIDATION_ERROR", "run already holds a task"); db.prepare("UPDATE tasks SET status='claimed', attempts=attempts+1, fencing_token=fencing_token+1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='queued'").run(t.id); event(db,"task.claimed",{ task_id:t.id, actor_run_id:runId, payload:{ run_id:runId, fencing_token:1 } }) })(); out({ ok:true, task:{ id:t.id, status:"claimed", token:1 } }); return 0 }
    if (a === "task" && b === "heartbeat") { const runId = req(rest,"--run"); const task = parseFlag(rest,"--task"); const token = parseFlag(rest,"--token"); if ((task === undefined) !== (token === undefined)) fail("VALIDATION_ERROR", "--task and --token must be supplied together"); if (task !== undefined) { const tr = row<TaskRow>(db.prepare("SELECT id,scope_id,capability,title,body,status,fencing_token,attempts,max_attempts,created_at FROM tasks WHERE id=?").get(task), `task not found: ${task}`); if (tr.fencing_token !== Number(token)) fail("STALE_TOKEN", "stale fencing token"); if (tr.status === "claimed") db.prepare("UPDATE tasks SET status='running', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(task); event(db,"task.heartbeat",{ task_id:task, actor_run_id:runId, payload:{ run_id:runId, fencing_token:Number(token), previous_status:tr.status, status: tr.status === "claimed" ? "running" : tr.status } }); out({ ok:true, task:{ id:task, status: tr.status === "claimed" ? "running" : tr.status } }); return 0 } event(db,"run.heartbeat",{ run_id:runId, payload:{ status:"live" } }); out({ ok:true }); return 0 }
    if (a === "task" && (b === "complete" || b === "fail")) { const taskId = c ?? fail("VALIDATION_ERROR", "missing task id"); const runId = req(rest,"--run"); const token = Number(req(rest,"--token")); const st = b === "complete" ? "done" : "failed"; const res = b === "complete" ? (parseFlag(rest,"--result-file") ? ctx.services.fs.readText(parseFlag(rest,"--result-file")!) : "{}") : JSON.stringify({ reason:req(rest,"--reason") }); const r = db.transaction(() => { const changes = db.prepare("UPDATE tasks SET status=?, result_json=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND fencing_token=? AND status IN ('claimed','running')").run(st, res, taskId, token).changes; if (changes === 0) fail("STALE_TOKEN_RACE", "stale token or task not active"); db.prepare("UPDATE runs SET task_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND task_id=?").run(runId, taskId); event(db, b === "complete" ? "task.completed" : "task.failed", { task_id:taskId, actor_run_id:runId, payload:{ run_id:runId, fencing_token:token } }); return row<TaskRow>(db.prepare("SELECT id,scope_id,capability,title,body,status,fencing_token,attempts,max_attempts,created_at FROM tasks WHERE id=?").get(taskId), `task not found: ${taskId}`) })(); out({ ok:true, task:{ id:taskId, status:r.status } }); return 0 }
    if (a === "task" && b === "inspect") { const taskId = c ?? fail("VALIDATION_ERROR", "missing task id"); const t = row<TaskRow>(db.prepare("SELECT id,scope_id,capability,title,body,status,fencing_token,attempts,max_attempts,created_at FROM tasks WHERE id=?").get(taskId), `task not found: ${taskId}`); const deps = db.prepare("SELECT t.id,t.scope_id,t.status,t.title FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=? ORDER BY d.created_at,t.id").all(taskId); const unresolved = (deps as {id:string;status:string}[]).filter((d) => d.status !== "done").map((d) => d.id); const dependents = db.prepare("SELECT t.id,t.scope_id,t.status,t.title FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE d.depends_on_task_id=? ORDER BY d.created_at,t.id").all(taskId); out({ ok:true, task:{ id:t.id, scope_id:t.scope_id, capability:t.capability, status:t.status, claimable:t.status === "queued" && unresolved.length === 0, unresolved_dependency_ids:unresolved }, dependencies:deps, dependents, supersedes:null, superseded_by:null, artifacts:[] }); return 0 }
    if (a === "graph" && b === "inspect") { out({ ok:true, graph:{ selector: parseFlag(rest,"--all") !== undefined || rest.includes("--all") ? { kind:"all" } : { kind:"task", value:parseFlag(rest,"--task") ?? parseFlag(rest,"--scope") }, nodes:[], edges:[] } }); return 0 }
    if (a === "events" && b === "tail") { out({ ok:true, events: db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?").all(Number(parseFlag(rest,"--limit") ?? 100)) }); return 0 }
    if (a === "briefing") { out({ ok:true, ready:[], blocked:[] }); return 0 }
    if (a === "task" && b === "artifact" && c === "add") { const task = req(rest,"--task"); const runId = req(rest,"--run"); const aid = id("artifact"); db.prepare("INSERT INTO artifacts(id,task_id,run_id,kind,title,body) VALUES (?,?,?,?,?,?)").run(aid, task, runId, req(rest,"--kind"), req(rest,"--title"), parseFlag(rest,"--body-file") ? ctx.services.fs.readText(parseFlag(rest,"--body-file")!) : ""); out({ ok:true, artifact:{ id:aid } }); return 0 }
    if (a === "task" && ["supersede","cancel"].includes(b ?? "")) { out({ ok:true }); return 0 }
    fail("VALIDATION_ERROR", `unknown command: ${argv.join(" ")}`)
    return 1
  } catch (error) {
    if (error instanceof PithosError) { ctx.services.output.writeError(json({ ok:false, error:{ code:error.code, message:error.message } })); return error.code === "NO_CLAIMABLE_WORK" ? 5 : 1 }
    throw error
  }
}
