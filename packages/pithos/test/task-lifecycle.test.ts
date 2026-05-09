import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { PithosError, makeEngine, type Services } from "../src/index.js";

const tempDb = () => join(mkdtempSync(join(tmpdir(), "pithos-next-task-")), "pithos.db");

const services = (): Services => ({
	fs: {
		readText: () => JSON.stringify({ ok: true }),
		removeFile: (path) => rmSync(path, { force: true }),
	},
	output: { write: () => undefined, writeError: () => undefined },
	ids: { make: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 8)}` },
	clock: { nowIso: () => "2026-05-08T00:00:00.000Z" },
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
		runId: "run_toil",
	});
	engine.runUpsert({
		agent: "war",
		mode: "afk",
		scope: repo,
		cwd: "/tmp/pithos-repo",
		sessionId: "s_war",
		runId: "run_war",
	});
	engine.runUpsert({
		agent: "pdx",
		mode: "afk",
		scope: "global",
		cwd: "/tmp",
		sessionId: "s_pdx",
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
		expect(
			engine.artifactAdd({
				taskId: enq.task.id,
				runId: "run_war",
				kind: "note",
				title: "evidence",
				bodyFile: undefined,
			}),
		).toMatchObject({ ok: true, artifact: { id: expect.any(String) } });
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
			ready: [expect.objectContaining({ id: blocker })],
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
		expect(
			engine.graphInspect({
				taskId: downstream,
				scope: undefined,
				all: false,
				flat: false,
				dump: false,
			}),
		).toMatchObject({
			ok: true,
			graph: {
				nodes: expect.arrayContaining([
					expect.objectContaining({
						id: blocker,
						status: "cancelled",
						superseded_by_task_id: replacement.task.id,
					}),
					expect.objectContaining({ id: replacement.task.id, supersedes_task_id: blocker }),
					expect.objectContaining({
						id: downstream,
						unresolved_dependency_ids: [replacement.task.id],
					}),
				]),
				edges: expect.arrayContaining([
					expect.objectContaining({
						kind: "supersedes",
						from_task_id: replacement.task.id,
						to_task_id: blocker,
					}),
					expect.objectContaining({
						kind: "depends_on",
						from_task_id: downstream,
						to_task_id: replacement.task.id,
					}),
				]),
			},
		});
	});
});
