import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_CONTRACT,
	liveServices,
	PithosError,
	RunRowSchema,
	decodeRow,
	loadConfig,
	makeEngine,
	type Services,
} from "../src/index.js";

const tempDb = () => join(mkdtempSync(join(tmpdir(), "pithos-")), "pithos.db");

const services = (
	fs: Partial<Services["fs"]> = {},
): Services & { stdout: string[]; stderr: string[] } => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let idCounter = 0;
	return {
		stdout,
		stderr,
		fs: {
			readText: () => Effect.succeed("body"),
			removeFile: (path) => Effect.sync(() => rmSync(path, { force: true })),
			existsDirectory: () => Effect.succeed(true),
			...fs,
		},
		input: { readStdin: () => Effect.succeed({ _tag: "NoRedirectedStdin" as const }) },
		output: {
			write: (text) => Effect.sync(() => void stdout.push(text)),
			writeError: (text) => Effect.sync(() => void stderr.push(text)),
			isTty: () => false,
		},
		ids: { make: (prefix) => Effect.sync(() => `${prefix}_test_${idCounter++}`) },
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
		).toEqual([
			"envy:intake",
			"greed:design",
			"greed:review",
			"pandora:escalate",
			"toil:triage",
			"war:execute",
		]);
		expect(
			db
				.prepare("SELECT agent_kind || ':' || capability FROM agent_enqueues ORDER BY 1")
				.pluck()
				.all(),
		).toEqual([
			"envy:design",
			"envy:escalate",
			"envy:triage",
			"greed:design",
			"greed:escalate",
			"greed:triage",
			"pandora:design",
			"pandora:escalate",
			"pandora:execute",
			"pandora:review",
			"pandora:triage",
			"pdx:escalate",
			"pdx:intake",
			"toil:design",
			"toil:escalate",
			"toil:execute",
			"toil:review",
			"toil:triage",
			"war:escalate",
		]);
		expect(
			db
				.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_runs_task_id'")
				.pluck()
				.get(),
		).toContain("WHERE task_id IS NOT NULL");
		expect(
			db
				.prepare("SELECT name FROM pragma_table_info('scopes') WHERE name = 'archived_at'")
				.pluck()
				.get(),
		).toBe("archived_at");
		expect(
			db
				.prepare("SELECT name FROM pragma_table_info('scopes') WHERE name = 'description'")
				.pluck()
				.get(),
		).toBe("description");
		expect(
			db
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_events_created_at'",
				)
				.pluck()
				.get(),
		).toContain("ON events(created_at)");
		expect(
			db
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_events_type_created_at'",
				)
				.pluck()
				.get(),
		).toContain("ON events(type, created_at)");
	});

	it("non-fresh init is idempotent", () => {
		const dbPath = tempDb();
		initEngine(dbPath, true).close();
		initEngine(dbPath).close();
		const db = new Database(dbPath);
		expect(db.prepare("SELECT COUNT(*) FROM agent_kinds").pluck().get()).toBe(6);
		expect(db.prepare("SELECT COUNT(*) FROM agent_enqueues").pluck().get()).toBe(19);
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
			parent_repo_path: null,
			archived_at: null,
			description: null,
		});
		expect(engine.scopeList({ all: false })).toEqual({
			ok: true,
			scopes: [
				{
					id: "global",
					kind: "global",
					canonical_path: null,
					parent_repo_path: null,
					archived_at: null,
					description: null,
					task_count: 0,
					run_count: 0,
				},
				{
					id: repo.scope.id,
					kind: "repo",
					canonical_path: "/tmp/pithos-repo",
					parent_repo_path: null,
					archived_at: null,
					description: null,
					task_count: 0,
					run_count: 0,
				},
			],
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
		expect(engine.scopeList({ all: false })).toEqual({
			ok: true,
			scopes: [
				{
					id: "global",
					kind: "global",
					canonical_path: null,
					parent_repo_path: null,
					archived_at: null,
					description: null,
					task_count: 0,
					run_count: 0,
				},
				{
					id: repo.scope.id,
					kind: "repo",
					canonical_path: "/tmp/pithos-repo",
					parent_repo_path: null,
					archived_at: null,
					description: null,
					task_count: 0,
					run_count: 1,
				},
			],
		});
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

	it("scope archive rejects global, live runs, and non-terminal tasks", () => {
		const dbPath = tempDb();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		engine.init({ fresh: true });
		const repo = engine.scopeUpsert({ kind: "repo", path: "/tmp/pithos-archive-guards" });
		engine.runUpsert({
			agent: "toil",
			mode: "afk",
			scope: "global",
			cwd: "/tmp",
			sessionId: "session_toil",
			harnessKind: "claude",
			sessionLogPath: "/tmp/session_toil.jsonl",
			runId: "run_toil",
		});
		expect(() => engine.scopeArchive({ scopeId: "global" })).toThrow(PithosError);
		const taskId = engine.enqueue({
			scope: repo.scope.id,
			capability: "execute",
			title: "queued repo task",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		expect(() => engine.scopeArchive({ scopeId: repo.scope.id })).toThrow(/non-terminal task/);
		const db = new Database(dbPath);
		for (const status of ["claimed", "running"] as const) {
			db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, taskId);
			expect(() => engine.scopeArchive({ scopeId: repo.scope.id })).toThrow(/non-terminal task/);
		}
		db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
		db.close();
		engine.runUpsert({
			agent: "war",
			mode: "afk",
			scope: repo.scope.id,
			cwd: "/tmp/pithos-archive-guards",
			sessionId: "session_war",
			harnessKind: "claude",
			sessionLogPath: "/tmp/session_war.jsonl",
			runId: "run_war",
		});
		expect(() => engine.scopeArchive({ scopeId: repo.scope.id })).toThrow(/live run/);
	});

	it("scope archive hides historical scopes until upsert reactivates them", () => {
		const dbPath = tempDb();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		engine.init({ fresh: true });
		engine.runUpsert({
			agent: "toil",
			mode: "afk",
			scope: "global",
			cwd: "/tmp",
			sessionId: "session_toil",
			harnessKind: "claude",
			sessionLogPath: "/tmp/session_toil_archive.jsonl",
			runId: "run_toil",
		});
		const repo = engine.scopeUpsert({ kind: "repo", path: "/tmp/pithos-archive-history" });
		const taskId = engine.enqueue({
			scope: repo.scope.id,
			capability: "execute",
			title: "terminal repo task",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		engine.cancel({ taskId, runId: "run_toil", reason: "done with history" });
		const archived = engine.scopeArchive({ scopeId: repo.scope.id });
		expect(archived).toMatchObject({
			ok: true,
			action: "archived",
			scope: {
				id: repo.scope.id,
				kind: "repo",
				canonical_path: "/tmp/pithos-archive-history",
				task_count: 1,
				run_count: 0,
			},
		});
		expect(archived.scope.archived_at).toEqual(expect.any(String));
		expect(engine.scopeList({ all: false }).scopes.map((scope) => scope.id)).toEqual(["global"]);
		const archivedScope = engine
			.scopeList({ all: true })
			.scopes.find((scope) => scope.id === repo.scope.id);
		expect(archivedScope).toBeDefined();
		expect(archivedScope?.archived_at).toEqual(expect.any(String));
		expect(archivedScope?.task_count).toBe(1);
		expect(archivedScope?.run_count).toBe(0);
		expect(() =>
			engine.enqueue({
				scope: repo.scope.id,
				capability: "execute",
				title: "blocked while archived",
				body: "body",
				bodyFile: undefined,
				runId: "run_toil",
				dependsOn: [],
				chain: "auto",
			}),
		).toThrow(/scope is archived/);
		expect(() =>
			engine.runUpsert({
				agent: "war",
				mode: "afk",
				scope: repo.scope.id,
				cwd: "/tmp/pithos-archive-history",
				sessionId: "session_war",
				harnessKind: "pi",
				sessionLogPath: "/tmp/session_war_archive.jsonl",
				runId: "run_war",
			}),
		).toThrow(/scope is archived/);
		expect(engine.scopeUpsert({ kind: "repo", path: "/tmp/pithos-archive-history" }).scope).toEqual(
			{
				id: repo.scope.id,
				kind: "repo",
				canonical_path: "/tmp/pithos-archive-history",
				parent_repo_path: null,
				archived_at: null,
				description: null,
			},
		);
		expect(engine.scopeList({ all: false }).scopes).toContainEqual(
			expect.objectContaining({
				id: repo.scope.id,
				archived_at: null,
				task_count: 1,
				run_count: 0,
			}),
		);
	});

	it("scope archive physically deletes unreferenced scopes", () => {
		const dbPath = tempDb();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		engine.init({ fresh: true });
		const repo = engine.scopeUpsert({ kind: "repo", path: "/tmp/pithos-archive-delete" });
		expect(engine.scopeArchive({ scopeId: repo.scope.id })).toEqual({
			ok: true,
			action: "deleted",
			scope: {
				id: repo.scope.id,
				kind: "repo",
				canonical_path: "/tmp/pithos-archive-delete",
				parent_repo_path: null,
				archived_at: null,
				description: null,
				task_count: 0,
				run_count: 0,
			},
		});
		expect(engine.scopeList({ all: true }).scopes.map((scope) => scope.id)).toEqual(["global"]);
	});

	it("scope upsert rejects empty repo/worktree paths", () => {
		const dbPath = tempDb();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		engine.init({ fresh: true });
		expect(() => engine.scopeUpsert({ kind: "repo", path: "" })).toThrow(PithosError);
	});

	it("scope upsert requires repo/worktree paths to exist as directories", () => {
		const dbPath = tempDb();
		const root = mkdtempSync(join(tmpdir(), "pithos-scope-path-"));
		const parentRepo = mkdtempSync(join(tmpdir(), "pithos-parent-repo-"));
		const filePath = join(root, "file.txt");
		writeFileSync(filePath, "not a directory");
		const engine = makeEngine({
			config: { dbPath },
			services: services({ existsDirectory: liveServices.fs.existsDirectory }),
		});
		engine.init({ fresh: true });
		expect(engine.scopeUpsert({ kind: "repo", path: root }).scope).toMatchObject({
			id: `repo:${root}`,
			canonical_path: root,
			parent_repo_path: null,
		});
		expect(
			engine.scopeUpsert({ kind: "worktree", path: root, parentRepoPath: parentRepo }).scope,
		).toMatchObject({
			id: `worktree:${root}`,
			canonical_path: root,
			parent_repo_path: parentRepo,
		});
		const errors = [
			["repo", join(root, "missing"), undefined] as const,
			["worktree", filePath, parentRepo] as const,
			["worktree", root, join(parentRepo, "missing")] as const,
		].map(([kind, path, parentRepoPath]) => {
			try {
				engine.scopeUpsert({ kind, path, parentRepoPath });
			} catch (error) {
				if (error instanceof PithosError) return error;
				throw error;
			}
			throw new Error("scope upsert should reject non-directory paths");
		});
		expect(errors.map((error) => error.code)).toEqual([
			"VALIDATION_ERROR",
			"VALIDATION_ERROR",
			"VALIDATION_ERROR",
		]);
		expect(errors.map((error) => error.message)).toEqual([
			expect.stringContaining("Create the directory first"),
			expect.stringContaining("Create the directory first"),
			expect.stringContaining("parent repo directory first"),
		]);
	});

	it("scope upsert rejects missing parent repo for worktree scopes", () => {
		const dbPath = tempDb();
		const root = mkdtempSync(join(tmpdir(), "pithos-worktree-scope-"));
		const engine = makeEngine({
			config: { dbPath },
			services: services({ existsDirectory: liveServices.fs.existsDirectory }),
		});
		engine.init({ fresh: true });
		expect(() => engine.scopeUpsert({ kind: "worktree", path: root })).toThrow(
			/missing --parent-repo/,
		);
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

	it("prunes heartbeat and non-heartbeat events with strict age cutoffs and returns counts", () => {
		const dbPath = tempDb();
		const db = initEngine(dbPath, true);
		const rows = [
			["event_old_hb", "run.heartbeat", { n: 1 }, "2026-05-06 23:59:59"],
			["event_boundary_hb", "task.heartbeat", { n: 2 }, "2026-05-07 00:00:00"],
			["event_fresh_hb", "run.heartbeat", { n: 3 }, "2026-05-07 00:00:01"],
			["event_old_other", "task.created", { n: 4 }, "2026-04-30 23:59:59"],
			["event_boundary_other", "task.failed", { n: 5 }, "2026-05-01 00:00:00"],
			["event_fresh_other", "run.cleanup", { n: 6 }, "2026-05-01 00:00:01"],
		] as const;
		for (const [id, type, payload, createdAt] of rows) {
			db.prepare("INSERT INTO events (id, type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(
				id,
				type,
				JSON.stringify(payload),
				createdAt,
			);
		}
		db.close();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		expect(engine.pruneEvents()).toEqual({
			ok: true,
			deleted_heartbeat: 1,
			deleted_other: 1,
		});
		const verifyDb = new Database(dbPath);
		const remaining = verifyDb
			.prepare("SELECT id FROM events ORDER BY created_at ASC, id ASC")
			.pluck()
			.all();
		verifyDb.close();
		expect(remaining).toEqual([
			"event_boundary_other",
			"event_fresh_other",
			"event_boundary_hb",
			"event_fresh_hb",
		]);
	});

	it("pruneEvents rejects non-positive retention windows", () => {
		const dbPath = tempDb();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		engine.init({ fresh: true });
		expect(() => engine.pruneEvents({ heartbeatOlderThanDays: 0 })).toThrow(PithosError);
		expect(() => engine.pruneEvents({ otherOlderThanDays: -1 })).toThrow(PithosError);
	});

	it("authorizes review claims and enqueues for the scoped review contract", () => {
		const dbPath = tempDb();
		const engine = makeEngine({ config: { dbPath }, services: services() });
		engine.init({ fresh: true });
		for (const agent of ["greed", "war", "envy", "pandora", "toil"] as const) {
			engine.runUpsert({
				agent,
				mode: agent === "greed" || agent === "pandora" ? "hitl" : "afk",
				scope: "global",
				cwd: "/tmp",
				sessionId: `session_${agent}`,
				harnessKind: "claude",
				sessionLogPath: `/tmp/session_${agent}.jsonl`,
				runId: `run_${agent}`,
			});
		}
		const reviewInput = (runId: string, title: string) => ({
			runId,
			scope: "global",
			capability: "review" as const,
			title,
			body: "review body",
			bodyFile: undefined,
			dependsOn: [],
			chain: "none" as const,
		});
		expect(engine.enqueue(reviewInput("run_pandora", "Review"))).toMatchObject({
			task: { status: "queued" },
		});
		expect(engine.enqueue(reviewInput("run_toil", "Review 2"))).toMatchObject({
			task: { status: "queued" },
		});
		expect(() => engine.enqueue(reviewInput("run_greed", "Bad"))).toThrow(/not authorized/);
		expect(() => engine.enqueue(reviewInput("run_war", "Bad"))).toThrow(/not authorized/);
		expect(() => engine.enqueue(reviewInput("run_envy", "Bad"))).toThrow(/not authorized/);
		expect(
			engine.claim({ runId: "run_greed", scope: "global", capability: "review" }),
		).toMatchObject({
			task: { status: "claimed", capability: "review" },
		});
		expect(() =>
			engine.claim({ runId: "run_pandora", scope: "global", capability: "review" }),
		).toThrow(/not authorized/);
		expect(() =>
			engine.claim({ runId: "run_toil", scope: "global", capability: "review" }),
		).toThrow(/not authorized/);
		expect(() => engine.claim({ runId: "run_war", scope: "global", capability: "review" })).toThrow(
			/not authorized/,
		);
		expect(() =>
			engine.claim({ runId: "run_envy", scope: "global", capability: "review" }),
		).toThrow(/not authorized/);
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

	it("live IdService produces word-based IDs for task/run/artifact and hex for event", async () => {
		const word = "[a-z]+(?:-[a-z]+)*";
		const wordFormat = new RegExp(`^(task|run|artifact)_${word}-${word}-${word}$`);
		const hexFormat = /^event_[0-9a-f]{16}$/;
		for (const prefix of ["task", "run", "artifact"] as const) {
			const id = await Effect.runPromise(liveServices.ids.make(prefix));
			expect(id, `${prefix} ID format`).toMatch(wordFormat);
		}
		const eventId = await Effect.runPromise(liveServices.ids.make("event"));
		expect(eventId, "event ID format").toMatch(hexFormat);
	});
});
