import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_CONTRACT,
	PithosError,
	RunRowSchema,
	decodeRow,
	loadConfig,
	makeEngine,
	type Services,
} from "../src/index.js";

const tempDb = () => join(mkdtempSync(join(tmpdir(), "pithos-")), "pithos.db");

const services = (): Services & { stdout: string[]; stderr: string[] } => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		fs: {
			readText: () => Effect.succeed("body"),
			removeFile: (path) => Effect.sync(() => rmSync(path, { force: true })),
		},
		input: { readStdin: () => Effect.succeed({ _tag: "NoRedirectedStdin" as const }) },
		output: {
			write: (text) => Effect.sync(() => void stdout.push(text)),
			writeError: (text) => Effect.sync(() => void stderr.push(text)),
		},
		ids: { make: (prefix) => Effect.succeed(`${prefix}_test_${stdout.length}_${stderr.length}`) },
		clock: { nowIso: () => Effect.succeed("2026-05-08T00:00:00.000Z") },
	};
};

const initEngine = (dbPath: string, fresh = false) => {
	makeEngine({ config: { dbPath }, services: services() }).init({ fresh });
	return new Database(dbPath);
};

describe("pithos foundation", () => {
	it("fresh init creates schema, seeds, and partial run task index", () => {
		const db = initEngine(tempDb(), true);
		expect(db.prepare("SELECT id FROM scopes").pluck().all()).toEqual(["global"]);
		expect(
			db.prepare("SELECT agent_kind FROM agent_kinds ORDER BY agent_kind").pluck().all(),
		).toEqual([...BUILTIN_CONTRACT.agentKinds].sort());
		expect(
			db.prepare("SELECT capability FROM capabilities ORDER BY capability").pluck().all(),
		).toEqual([...BUILTIN_CONTRACT.capabilities].sort());
		expect(
			db
				.prepare("SELECT agent_kind || ':' || capability FROM agent_claims ORDER BY 1")
				.pluck()
				.all(),
		).toEqual(["greed:design", "pandora:escalate", "toil:triage", "war:execute"]);
		expect(
			db
				.prepare("SELECT agent_kind || ':' || capability FROM agent_enqueues ORDER BY 1")
				.pluck()
				.all(),
		).toEqual([
			"greed:design",
			"greed:escalate",
			"greed:triage",
			"pandora:design",
			"pandora:escalate",
			"pandora:triage",
			"pdx:escalate",
			"toil:design",
			"toil:escalate",
			"toil:execute",
			"toil:triage",
			"war:escalate",
		]);
		expect(
			db
				.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_runs_task_id'")
				.pluck()
				.get(),
		).toContain("WHERE task_id IS NOT NULL");
	});

	it("non-fresh init is idempotent", () => {
		const dbPath = tempDb();
		initEngine(dbPath, true).close();
		initEngine(dbPath).close();
		const db = new Database(dbPath);
		expect(db.prepare("SELECT COUNT(*) FROM agent_kinds").pluck().get()).toBe(5);
		expect(db.prepare("SELECT COUNT(*) FROM agent_enqueues").pluck().get()).toBe(12);
	});

	it("exported built-in contract matches seeded rows", () => {
		const db = initEngine(tempDb(), true);
		const seeded = db
			.prepare("SELECT agent_kind, capability FROM agent_enqueues ORDER BY 1,2")
			.all();
		const contract = Object.entries(BUILTIN_CONTRACT.enqueues)
			.flatMap(([agent_kind, caps]) => caps.map((capability) => ({ agent_kind, capability })))
			.sort((a, b) =>
				`${a.agent_kind}:${a.capability}`.localeCompare(`${b.agent_kind}:${b.capability}`),
			);
		expect(seeded).toEqual(contract);
	});

	it("scope and run commands return minimum output contracts", () => {
		const dbPath = tempDb();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		engine.init({ fresh: true });
		const repo = engine.scopeUpsert({ kind: "repo", path: "/tmp/pithos-repo" });
		expect(repo.scope).toEqual({
			id: "repo:/tmp/pithos-repo",
			kind: "repo",
			canonical_path: "/tmp/pithos-repo",
		});
		const upserted = engine.runUpsert({
			agent: "war",
			mode: "afk",
			scope: repo.scope.id,
			cwd: "/tmp/pithos-repo",
			sessionId: "session_war",
			harnessKind: "claude",
			sessionLogPath: "/tmp/session_war.jsonl",
			runId: "run_war",
		});
		expect(upserted.run).toMatchObject({
			id: "run_war",
			agent: "war",
			mode: "afk",
			scope_id: repo.scope.id,
			status: "live",
			task_id: null,
			session_id: "session_war",
			harness_kind: "claude",
			session_log_path: "/tmp/session_war.jsonl",
		});
		expect(upserted.run.created_at).toEqual(expect.any(String));
		expect(upserted.run.updated_at).toEqual(expect.any(String));
		expect(engine.runInspect({ runId: "run_war" })).toEqual(upserted);
	});

	it("run upsert rejects empty durable run fields before writing", () => {
		const dbPath = tempDb();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		engine.init({ fresh: true });
		expect(() =>
			engine.runUpsert({
				agent: "war",
				mode: "afk",
				scope: "global",
				cwd: "/tmp",
				sessionId: "",
				harnessKind: "claude",
				sessionLogPath: "/tmp/session_empty.jsonl",
				runId: "run_empty_session",
			}),
		).toThrow(PithosError);
		expect(() =>
			engine.runUpsert({
				agent: "war",
				mode: "afk",
				scope: "global",
				cwd: "/tmp",
				sessionId: "session",
				harnessKind: "bogus" as never,
				sessionLogPath: "/tmp/session.jsonl",
				runId: "run_bad_harness",
			}),
		).toThrow(PithosError);
		expect(() =>
			engine.runUpsert({
				agent: "war",
				mode: "afk",
				scope: "global",
				cwd: "/tmp",
				sessionId: "session",
				harnessKind: "claude",
				sessionLogPath: "",
				runId: "run_empty_log",
			}),
		).toThrow(PithosError);
		const db = new Database(dbPath);
		expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
		db.close();
	});

	it("scope upsert rejects empty repo/worktree paths", () => {
		const dbPath = tempDb();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		engine.init({ fresh: true });
		expect(() => engine.scopeUpsert({ kind: "repo", path: "" })).toThrow(PithosError);
	});

	it("run upsert rejects unknown scopes as PithosError", () => {
		const dbPath = tempDb();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		engine.init({ fresh: true });
		expect(() =>
			engine.runUpsert({
				agent: "war",
				mode: "afk",
				scope: "repo:/missing",
				cwd: "/tmp",
				sessionId: "session",
				harnessKind: "pi",
				sessionLogPath: "/tmp/session.jsonl",
				runId: "run_missing_scope",
			}),
		).toThrow(PithosError);
	});

	it("events tail returns durable event rows deterministically with limit handling", () => {
		const dbPath = tempDb();
		const db = initEngine(dbPath, true);
		db.prepare("INSERT INTO events (id, type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(
			"event_a",
			"run.heartbeat",
			JSON.stringify({ n: 1 }),
			"2026-05-08T00:00:00.000Z",
		);
		db.prepare("INSERT INTO events (id, type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(
			"event_b",
			"run.heartbeat",
			JSON.stringify({ n: 2 }),
			"2026-05-08T00:00:01.000Z",
		);
		db.close();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		expect(engine.eventsTail({ limit: 1 }).events).toEqual([
			expect.objectContaining({ id: "event_b", type: "run.heartbeat", payload: { n: 2 } }),
		]);
		expect(() => engine.eventsTail({ limit: 0 })).toThrow(PithosError);
	});

	it("empty claims use the no-work engine contract", () => {
		const dbPath = tempDb();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		engine.init({ fresh: true });
		engine.runUpsert({
			agent: "toil",
			mode: "afk",
			scope: "global",
			cwd: "/tmp",
			sessionId: "session",
			harnessKind: "claude",
			sessionLogPath: "/tmp/session_toil.jsonl",
			runId: "run_toil",
		});
		expect(() =>
			engine.claim({ runId: "run_toil", scope: "global", capability: "triage" }),
		).toThrow(PithosError);
	});

	it("row decoders and config decoding fail loudly", () => {
		expect(() => decodeRow(RunRowSchema, { id: "run_bad" }, "bad run")).toThrow(PithosError);
		expect(() => loadConfig({ get: () => undefined })).toThrow(PithosError);
		expect(
			loadConfig({
				get: (name) => (name === "PITHOS_DB" ? "/tmp/pithos.db" : ""),
			}),
		).toEqual({ dbPath: "/tmp/pithos.db" });
	});
});
