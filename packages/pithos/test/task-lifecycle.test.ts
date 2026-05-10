import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { PithosError, makeEngine, type Services } from "../src/index.js";

const tempDb = () => join(mkdtempSync(join(tmpdir(), "pithos-task-")), "pithos.db");

const services = (): Services => ({
	fs: {
		readText: () => Effect.succeed(JSON.stringify({ ok: true })),
		removeFile: (path) => Effect.sync(() => rmSync(path, { force: true })),
	},
	output: { write: () => Effect.void, writeError: () => Effect.void },
	ids: {
		make: (prefix) => Effect.succeed(`${prefix}_${randomUUID().replaceAll("-", "").slice(0, 8)}`),
	},
	clock: { nowIso: () => Effect.succeed("2026-05-08T00:00:00.000Z") },
});

const setup = (runIdEnv?: string) => {
	const dbPath = tempDb();
	const engine = makeEngine({ config: { dbPath, runId: runIdEnv }, services: services() });
	engine.init({ fresh: true });
	const repo = engine.scopeUpsert({ kind: "repo", path: "/tmp/pithos-repo" }).scope.id;
	engine.runUpsert({
		agent: "toil",
		mode: "afk",
		scope: "global",
		cwd: "/tmp",
		sessionId: "s_toil",
		harnessKind: "claude",
		sessionLogPath: "/tmp/s_toil.jsonl",
		runId: "run_toil",
	});
	engine.runUpsert({
		agent: "war",
		mode: "afk",
		scope: repo,
		cwd: "/tmp/pithos-repo",
		sessionId: "s_war",
		harnessKind: "pi",
		sessionLogPath: "/tmp/s_war.jsonl",
		runId: "run_war",
	});
	engine.runUpsert({
		agent: "pdx",
		mode: "afk",
		scope: "global",
		cwd: "/tmp",
		sessionId: "s_pdx",
		harnessKind: "pi",
		sessionLogPath: "/tmp/s_pdx.jsonl",
		runId: "run_pdx",
	});
	return { dbPath, engine, repo };
};

describe("task lifecycle", () => {
	it("round trips enqueue claim heartbeat complete with fencing", () => {
		const { dbPath, engine, repo } = setup();
		const enq = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "do it",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
		});
		const claimed = engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		expect(claimed.task.id).toBe(enq.task.id);
		expect(claimed.task.token).toBe(1);
		expect(engine.heartbeat({ runId: "run_war", taskId: enq.task.id, token: 1 })).toEqual({
			ok: true,
			status: "running",
		});
		expect(engine.heartbeat({ runId: "run_war", taskId: enq.task.id, token: 1 })).toEqual({
			ok: true,
			status: "running",
		});
		const artifact = engine.artifactAdd({
			taskId: enq.task.id,
			runId: "run_war",
			kind: "note",
			title: "evidence",
			bodyFile: undefined,
		});
		expect(artifact.ok).toBe(true);
		expect(artifact.artifact.id.startsWith("artifact_")).toBe(true);
		expect(
			engine.complete({ taskId: enq.task.id, runId: "run_war", token: 1, resultFile: undefined }),
		).toEqual({ ok: true, task: { id: enq.task.id, status: "done" } });
		const db = new Database(dbPath);
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(enq.task.id)).toBe("done");
		expect(db.prepare("SELECT task_id FROM runs WHERE id='run_war'").pluck().get()).toBeNull();
	});

	it("enforces authorization, scope capability rules, and one held task", () => {
		const { engine, repo } = setup();
		for (const capability of ["triage", "design", "execute"] as const) {
			expect(() =>
				engine.enqueue({
					scope: capability === "execute" ? repo : "global",
					capability,
					title: "bad",
					body: "body",
					bodyFile: undefined,
					runId: "run_pdx",
					dependsOn: [],
				}),
			).toThrow(PithosError);
		}
		expect(() =>
			engine.enqueue({
				scope: "global",
				capability: "execute",
				title: "bad",
				body: "body",
				bodyFile: undefined,
				runId: "run_toil",
				dependsOn: [],
			}),
		).toThrow(PithosError);
		for (const capability of ["design", "execute", "escalate"] as const) {
			expect(() => engine.claim({ runId: "run_toil", scope: "global", capability })).toThrow(
				PithosError,
			);
		}
		for (const capability of ["triage", "design", "escalate"] as const) {
			expect(() => engine.claim({ runId: "run_war", scope: repo, capability })).toThrow(
				PithosError,
			);
		}
		engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "a",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
		});
		expect(engine.claim({ runId: "run_war", scope: repo, capability: "execute" }).task.id).toEqual(
			expect.any(String),
		);
		expect(() => engine.claim({ runId: "run_war", scope: repo, capability: "execute" })).toThrow(
			PithosError,
		);
		expect(() =>
			engine.claim({ runId: "run_war", scope: "global", capability: "execute" }),
		).toThrow(PithosError);
	});

	it("resolves PITHOS_RUN_ID, validates dependencies, and blocks claims", () => {
		const { engine, repo } = setup("run_toil");
		expect(() =>
			engine.enqueue({
				scope: repo,
				capability: "execute",
				title: "bad",
				body: "body",
				bodyFile: undefined,
				runId: "other",
				dependsOn: [],
			}),
		).toThrow(PithosError);
		const blocker = engine.enqueue({
			scope: "global",
			capability: "triage",
			title: "blocker",
			body: "body",
			bodyFile: undefined,
			runId: undefined,
			dependsOn: [],
		});
		expect(() =>
			engine.enqueue({
				scope: repo,
				capability: "execute",
				title: "dup",
				body: "body",
				bodyFile: undefined,
				runId: undefined,
				dependsOn: [blocker.task.id, blocker.task.id],
			}),
		).toThrow(PithosError);
		engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "blocked",
			body: "body",
			bodyFile: undefined,
			runId: undefined,
			dependsOn: [blocker.task.id],
		});
		expect(() => engine.claim({ runId: "run_war", scope: repo, capability: "execute" })).toThrow(
			PithosError,
		);
	});

	it("heartbeat and stale token updates fail without partial mutation", () => {
		const { dbPath, engine, repo } = setup();
		const task = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "do",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
		}).task.id;
		engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		expect(() => engine.heartbeat({ runId: "run_war", taskId: task, token: undefined })).toThrow(
			PithosError,
		);
		expect(() =>
			engine.complete({ taskId: task, runId: "run_war", token: 99, resultFile: undefined }),
		).toThrow(PithosError);
		const db = new Database(dbPath);
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(task)).toBe("claimed");
		expect(db.prepare("SELECT task_id FROM runs WHERE id='run_war'").pluck().get()).toBe(task);
		expect(engine.failTask({ taskId: task, runId: "run_war", token: 1, reason: "bad" })).toEqual({
			ok: true,
			task: { id: task, status: "failed" },
		});
	});

	it("cleans up active held tasks by reclaiming or dead-lettering with fenced token increments", () => {
		const { dbPath, engine, repo } = setup();
		const task = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "cleanup me",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
		}).task.id;
		engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		expect(engine.runCleanup({ runId: "run_war", reason: "process exited" })).toMatchObject({
			ok: true,
			run: {
				id: "run_war",
				status: "failed",
				task_id: null,
				harness_kind: "pi",
				session_log_path: "/tmp/s_war.jsonl",
			},
		});
		const db = new Database(dbPath);
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(task)).toBe("queued");
		expect(db.prepare("SELECT fencing_token FROM tasks WHERE id=?").pluck().get(task)).toBe(2);
		const reclaimed = JSON.parse(
			db
				.prepare("SELECT payload_json FROM events WHERE type='task.reclaimed'")
				.pluck()
				.get() as string,
		) as unknown as {
			previous_run_id: string;
			attempts: number;
			max_attempts: number;
			previous_fencing_token: number;
			new_fencing_token: number;
		};
		expect(reclaimed).toMatchObject({
			previous_run_id: "run_war",
			attempts: 1,
			max_attempts: 3,
			previous_fencing_token: 1,
			new_fencing_token: 2,
		});

		engine.runUpsert({
			agent: "war",
			mode: "afk",
			scope: repo,
			cwd: "/tmp/pithos-repo",
			sessionId: "s_war2",
			harnessKind: "pi",
			sessionLogPath: "/tmp/s_war2.jsonl",
			runId: "run_war2",
		});
		engine.claim({ runId: "run_war2", scope: repo, capability: "execute" });
		db.prepare("UPDATE tasks SET attempts=max_attempts WHERE id=?").run(task);
		expect(engine.runCleanup({ runId: "run_war2", reason: "process exited" })).toMatchObject({
			run: {
				id: "run_war2",
				status: "failed",
				task_id: null,
				harness_kind: "pi",
				session_log_path: "/tmp/s_war2.jsonl",
			},
		});
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(task)).toBe("dead_letter");
		expect(db.prepare("SELECT fencing_token FROM tasks WHERE id=?").pluck().get(task)).toBe(4);
		expect(
			db.prepare("SELECT COUNT(*) FROM events WHERE type='task.dead_lettered'").pluck().get(),
		).toBe(1);
	});

	it("interrupts by run or held task and rejects missing task owners", () => {
		const { dbPath, engine, repo } = setup();
		const task = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "interrupt me",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
		}).task.id;
		expect(() => engine.runInterrupt({ runId: undefined, taskId: task, reason: "stop" })).toThrow(
			PithosError,
		);
		engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		expect(engine.runInterrupt({ runId: undefined, taskId: task, reason: "stop" })).toMatchObject({
			run: {
				id: "run_war",
				status: "failed",
				task_id: null,
				harness_kind: "pi",
				session_log_path: "/tmp/s_war.jsonl",
			},
		});
		const db = new Database(dbPath);
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(task)).toBe("failed");
		expect(db.prepare("SELECT fencing_token FROM tasks WHERE id=?").pluck().get(task)).toBe(2);
		const interrupted = JSON.parse(
			db
				.prepare("SELECT payload_json FROM events WHERE type='task.interrupted'")
				.pluck()
				.get() as string,
		) as unknown as {
			run_id: string;
			previous_status: string;
			previous_fencing_token: number;
			new_fencing_token: number;
		};
		expect(interrupted).toMatchObject({
			run_id: "run_war",
			previous_status: "claimed",
			previous_fencing_token: 1,
			new_fencing_token: 2,
		});
	});

	it("timeouts only no-claim live runs", () => {
		const { engine, repo } = setup();
		expect(() => engine.runTimeout({ runId: "run_pdx", reason: "no claim" })).toThrow(PithosError);
		expect(engine.runTimeout({ runId: "run_war", reason: "no claim" })).toMatchObject({
			ok: true,
			run: {
				id: "run_war",
				status: "timed_out",
				task_id: null,
				harness_kind: "pi",
				session_log_path: "/tmp/s_war.jsonl",
			},
		});
		expect(engine.runTimeout({ runId: "run_war", reason: "retry" })).toMatchObject({
			run: { id: "run_war", status: "timed_out", task_id: null },
		});
		engine.runUpsert({
			agent: "war",
			mode: "afk",
			scope: repo,
			cwd: "/tmp/pithos-repo",
			sessionId: "s_war2",
			harnessKind: "pi",
			sessionLogPath: "/tmp/s_war2.jsonl",
			runId: "run_war2",
		});
		const held = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "held",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
		}).task.id;
		engine.claim({ runId: "run_war2", scope: repo, capability: "execute" });
		expect(() => engine.runTimeout({ runId: "run_war2", reason: "no claim" })).toThrow(PithosError);
		engine.complete({ taskId: held, runId: "run_war2", token: 1, resultFile: undefined });
		expect(() => engine.runTimeout({ runId: "run_war2", reason: "no claim" })).toThrow(PithosError);
	});

	it("cancels queued tasks and rejects active task cancellation", () => {
		const { engine, repo } = setup();
		const queued = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "cancel me",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
		}).task.id;
		expect(engine.cancel({ taskId: queued, runId: "run_toil", reason: "not needed" })).toEqual({
			ok: true,
			task: { id: queued, status: "cancelled" },
		});
		expect(engine.taskInspect({ taskId: queued })).toMatchObject({
			task: { id: queued, status: "cancelled" },
		});

		const held = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "do not cancel active",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
		}).task.id;
		engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		expect(() => engine.cancel({ taskId: held, runId: "run_toil", reason: "bad" })).toThrow(
			/use pdx kill or pithos run interrupt/,
		);
	});

	it("inspects outputs and repairs a broken queued chain with supersede", () => {
		const { engine, repo } = setup();
		const blocker = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "old blocker",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
		}).task.id;
		const downstream = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "downstream",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [blocker],
		}).task.id;
		expect(engine.taskInspect({ taskId: downstream })).toMatchObject({
			ok: true,
			task: { id: downstream, claimable: false, unresolved_dependency_ids: [blocker] },
		});
		expect(engine.briefing({ agent: "war" })).toMatchObject({
			ok: true,
			ready: [
				expect.objectContaining({
					id: blocker,
					scope_kind: "repo",
					canonical_path: "/tmp/pithos-repo",
				}),
			],
			blocked: [expect.objectContaining({ id: downstream, unresolved_dependency_ids: [blocker] })],
		});
		const replacement = engine.supersede({
			taskId: blocker,
			runId: "run_toil",
			reason: "repair",
			title: "new blocker",
			body: "new body",
			bodyFile: undefined,
			scope: undefined,
			capability: undefined,
		}) as { task: { id: string } };
		expect(engine.taskInspect({ taskId: downstream })).toMatchObject({
			dependencies: [expect.objectContaining({ id: replacement.task.id })],
		});
		const graph = engine.graphInspect({
			taskId: downstream,
			scope: undefined,
			all: false,
			flat: false,
			dump: false,
		}) as {
			ok: true;
			graph: {
				nodes: readonly {
					id: string;
					status: string;
					superseded_by_task_id: string | null;
					supersedes_task_id: string | null;
					unresolved_dependency_ids: readonly string[];
				}[];
				edges: readonly { kind: string; from_task_id: string; to_task_id: string }[];
			};
		};
		expect(graph.ok).toBe(true);
		expect(graph.graph.nodes.find((node) => node.id === blocker)).toMatchObject({
			status: "cancelled",
			superseded_by_task_id: replacement.task.id,
		});
		expect(graph.graph.nodes.find((node) => node.id === replacement.task.id)).toMatchObject({
			supersedes_task_id: blocker,
		});
		expect(graph.graph.nodes.find((node) => node.id === downstream)).toMatchObject({
			unresolved_dependency_ids: [replacement.task.id],
		});
		expect(graph.graph.edges).toContainEqual({
			kind: "supersedes",
			from_task_id: replacement.task.id,
			to_task_id: blocker,
		});
		expect(graph.graph.edges).toContainEqual({
			kind: "depends_on",
			from_task_id: downstream,
			to_task_id: replacement.task.id,
			satisfied: false,
		});
	});
});
