import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	PithosError,
	makeEngine,
	renderGraphInspectText,
	type Capability,
	type ChainPolicy,
	type Engine,
	type Services,
} from "../src/index.js";

const tempDb = () => join(mkdtempSync(join(tmpdir(), "pithos-task-")), "pithos.db");

const services = (options?: { readonly existingDirectories?: ReadonlySet<string> }): Services => ({
	fs: {
		readText: () => Effect.succeed(JSON.stringify({ ok: true })),
		removeFile: (path) => Effect.sync(() => rmSync(path, { force: true })),
		existsDirectory: (path) =>
			Effect.succeed(
				options?.existingDirectories === undefined || options.existingDirectories.has(path),
			),
	},
	input: { readStdin: () => Effect.succeed({ _tag: "NoRedirectedStdin" as const }) },
	output: { write: () => Effect.void, writeError: () => Effect.void },
	ids: {
		make: (prefix) => Effect.succeed(`${prefix}_${randomUUID().replaceAll("-", "").slice(0, 8)}`),
	},
	clock: { nowIso: () => Effect.succeed("2026-05-08T00:00:00.000Z") },
});

const setup = (runIdEnv?: string, svc: Services = services()) => {
	const dbPath = tempDb();
	const engine = makeEngine({ config: { dbPath, runId: runIdEnv }, services: svc });
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
		agent: "greed",
		mode: "afk",
		scope: "global",
		cwd: "/tmp",
		sessionId: "s_greed",
		harnessKind: "claude",
		sessionLogPath: "/tmp/s_greed.jsonl",
		runId: "run_greed",
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
	engine.runUpsert({
		agent: "pdx",
		mode: "afk",
		scope: "global",
		cwd: "/tmp",
		sessionId: "s_pdx_system",
		harnessKind: "system",
		sessionLogPath: "/tmp/s_pdx_system.jsonl",
		runId: "run_pdx_system",
	});
	return { dbPath, engine, repo };
};

const enqueueTask = (
	engine: Engine,
	input: {
		readonly title: string;
		readonly capability?: Capability;
		readonly scope?: string;
		readonly runId?: string;
		readonly dependsOn?: readonly string[];
		readonly chain?: ChainPolicy;
	},
) =>
	engine.enqueue({
		scope: input.scope ?? "global",
		capability: input.capability ?? "triage",
		title: input.title,
		body: "body",
		bodyFile: undefined,
		runId: input.runId ?? "run_toil",
		dependsOn: input.dependsOn ?? [],
		chain: input.chain ?? "auto",
	});

const upsertPandoraRun = (engine: Engine): void => {
	engine.runUpsert({
		agent: "pandora",
		mode: "hitl",
		scope: "global",
		cwd: "/tmp",
		sessionId: "s_pandora",
		harnessKind: "claude",
		sessionLogPath: "/tmp/s_pandora.jsonl",
		runId: "run_pandora",
	});
};

const taskCreatedChain = (dbPath: string, taskId: string): unknown => {
	const db = new Database(dbPath);
	const payload = JSON.parse(
		db
			.prepare("SELECT payload_json FROM events WHERE type='task.created' AND task_id=?")
			.pluck()
			.get(taskId) as string,
	) as { chain: unknown };
	db.close();
	return payload.chain;
};

const claimSourcedEscalationWithPandora = (engine: Engine) => {
	upsertPandoraRun(engine);
	const source = enqueueTask(engine, { title: "held source" }).task.id;
	engine.claim({ runId: "run_toil", scope: "global", capability: "triage" });
	const escalation = enqueueTask(engine, {
		title: "needs attention",
		capability: "escalate",
		runId: "run_toil",
	}).task.id;
	engine.claim({ runId: "run_pandora", scope: "global", capability: "escalate" });
	return { source, escalation };
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
			chain: "auto",
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
			body: "evidence body",
		});
		expect(artifact.ok).toBe(true);
		expect(artifact.artifact.id.startsWith("artifact_")).toBe(true);
		expect(
			engine.complete({ taskId: enq.task.id, runId: "run_war", token: 1, resultJson: "{}" }),
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
					chain: "auto",
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
				chain: "auto",
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
			chain: "auto",
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

	it("rejects archived scopes in enqueue, claim, and supersede", () => {
		const { dbPath, engine, repo } = setup();
		const taskId = engine.enqueue({
			scope: "global",
			capability: "triage",
			title: "supersede source",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		const db = new Database(dbPath);
		db.prepare("UPDATE scopes SET archived_at = CURRENT_TIMESTAMP WHERE id = ?").run(repo);
		db.prepare(
			"INSERT INTO tasks(id, scope_id, capability, title, body, created_by_run_id) VALUES (?, ?, ?, ?, ?, ?)",
		).run("task_archived_claim", repo, "execute", "claim me", "body", "run_toil");
		db.close();
		expect(() =>
			engine.enqueue({
				scope: repo,
				capability: "execute",
				title: "bad",
				body: "body",
				bodyFile: undefined,
				runId: "run_toil",
				dependsOn: [],
				chain: "auto",
			}),
		).toThrow(/scope is archived/);
		expect(() => engine.claim({ runId: "run_war", scope: repo, capability: "execute" })).toThrow(
			/scope is archived/,
		);
		expect(() =>
			engine.supersede({
				taskId,
				runId: "run_toil",
				reason: "move",
				title: "move",
				body: "body",
				bodyFile: undefined,
				scope: repo,
				capability: "execute",
			}),
		).toThrow(/scope is archived/);
	});

	it("rejects enqueue when a repo scope path disappeared after upsert", () => {
		const existingDirectories = new Set(["/tmp/pithos-repo"]);
		const { dbPath, engine, repo } = setup(undefined, services({ existingDirectories }));
		existingDirectories.delete("/tmp/pithos-repo");

		expect(() =>
			engine.enqueue({
				scope: repo,
				capability: "execute",
				title: "bad",
				body: "body",
				bodyFile: undefined,
				runId: "run_toil",
				dependsOn: [],
				chain: "auto",
			}),
		).toThrow(
			"Create or restore the directory, then run `pithos scope upsert --kind repo --path /tmp/pithos-repo`.",
		);

		const db = new Database(dbPath);
		expect(db.prepare("SELECT COUNT(*) FROM tasks").pluck().get()).toBe(0);
		db.close();
	});

	it("rejects supersede when the replacement repo scope path disappeared after upsert", () => {
		const existingDirectories = new Set(["/tmp/pithos-repo"]);
		const { dbPath, engine, repo } = setup(undefined, services({ existingDirectories }));
		const original = enqueueTask(engine, { title: "replace me" }).task.id;
		existingDirectories.delete("/tmp/pithos-repo");

		expect(() =>
			engine.supersede({
				taskId: original,
				runId: "run_toil",
				reason: "move to repo",
				title: "replacement",
				body: "body",
				bodyFile: undefined,
				scope: repo,
				capability: "execute",
			}),
		).toThrow(
			"Create or restore the directory, then run `pithos scope upsert --kind repo --path /tmp/pithos-repo`.",
		);

		const db = new Database(dbPath);
		expect(db.prepare("SELECT COUNT(*) FROM tasks").pluck().get()).toBe(1);
		expect(db.prepare("SELECT COUNT(*) FROM task_supersessions").pluck().get()).toBe(0);
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(original)).toBe("queued");
		db.close();
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
				chain: "auto",
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
			chain: "auto",
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
				chain: "auto",
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
			chain: "auto",
		});
		expect(() => engine.claim({ runId: "run_war", scope: repo, capability: "execute" })).toThrow(
			PithosError,
		);
	});

	it("renders dependency forks in readable graph view", () => {
		const { engine, repo } = setup();
		const triage = enqueueTask(engine, {
			title: "triage root",
			capability: "triage",
			scope: repo,
		}).task.id;
		const design = enqueueTask(engine, {
			title: "design middle",
			capability: "design",
			scope: repo,
			dependsOn: [triage],
		}).task.id;
		const executeA = enqueueTask(engine, {
			title: "execute fork A",
			capability: "execute",
			scope: repo,
			dependsOn: [design],
		}).task.id;
		const executeB = enqueueTask(engine, {
			title: "execute fork B",
			capability: "execute",
			scope: repo,
			dependsOn: [design],
		}).task.id;
		const followUp = enqueueTask(engine, {
			title: "execute follow-up",
			capability: "execute",
			scope: repo,
			dependsOn: [executeA],
		}).task.id;

		const graphText = renderGraphInspectText(
			engine.graphInspect({
				taskId: undefined,
				scope: repo,
				all: false,
			}),
		);

		expect(graphText).toBe(
			[
				`- ${triage} [triage] [queued] triage root`,
				`  - ${design} [design] [blocked] design middle`,
				`    - ${executeA} [execute] [blocked] execute fork A`,
				`      - ${followUp} [execute] [blocked] execute follow-up`,
				`    - ${executeB} [execute] [blocked] execute fork B`,
				"",
			].join("\n"),
		);
	});

	it("deduplicates shared nodes in readable graph view for fan-in (diamond) dependencies", () => {
		const { engine, repo } = setup();
		const root = enqueueTask(engine, { title: "root task", capability: "triage", scope: repo }).task
			.id;
		const branchAlpha = enqueueTask(engine, {
			title: "alpha branch",
			capability: "execute",
			scope: repo,
			dependsOn: [root],
			chain: "none",
		}).task.id;
		const branchBeta = enqueueTask(engine, {
			title: "beta branch",
			capability: "execute",
			scope: repo,
			dependsOn: [root],
			chain: "none",
		}).task.id;
		const shared = enqueueTask(engine, {
			title: "shared leaf",
			capability: "execute",
			scope: repo,
			dependsOn: [branchAlpha, branchBeta],
			chain: "none",
		}).task.id;

		const graphText = renderGraphInspectText(
			engine.graphInspect({ taskId: undefined, scope: repo, all: false }),
		);

		expect(graphText).toBe(
			[
				`- ${root} [triage] [queued] root task`,
				`  - ${branchAlpha} [execute] [blocked] alpha branch`,
				`    - ${shared} [execute] [blocked] shared leaf`,
				`  - ${branchBeta} [execute] [blocked] beta branch`,
				`    - ↑ ${shared} already shown`,
				"",
			].join("\n"),
		);
	});

	it("deduplicates successor nodes in readable graph view when they appear in both supersession and dependency positions", () => {
		const { engine, repo } = setup();
		// parent is a shared upstream; original and its successor both inherit this dependency
		const parent = enqueueTask(engine, {
			title: "alpha parent",
			capability: "execute",
			scope: repo,
			chain: "none",
		}).task.id;
		const original = enqueueTask(engine, {
			title: "alpha original",
			capability: "execute",
			scope: repo,
			dependsOn: [parent],
			chain: "none",
		}).task.id;
		// complete parent so original becomes claimable
		const parentClaim = engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		engine.complete({
			taskId: parentClaim.task.id,
			runId: "run_war",
			token: parentClaim.task.token,
			resultJson: "{}",
		});
		// claim and fail original so it is recently failed (within 1 hour) and remains visible after supersession
		const originalClaim = engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		engine.failTask({
			taskId: originalClaim.task.id,
			runId: "run_war",
			token: originalClaim.task.token,
			reason: "needs redesign",
		});
		// supersede original; successor inherits the dependency on parent
		const successor = engine.supersede({
			taskId: original,
			runId: "run_toil",
			reason: "replanning",
			title: "beta successor",
			body: "body",
			bodyFile: undefined,
			scope: repo,
			capability: "execute",
		}).task.id;

		const graphText = renderGraphInspectText(
			engine.graphInspect({ taskId: undefined, scope: repo, all: false }),
		);

		// parent (done) is visible because original (recently failed, within 1 hour) is a visible child.
		// successor appears under original via ~> AND as a direct dependency child of parent.
		expect(graphText).toBe(
			[
				`- ${parent} [execute] [done] alpha parent`,
				`  - ${original} [execute] [failed] alpha original`,
				`    ~> ${successor} [execute] [queued] beta successor`,
				`  - ↑ ${successor} already shown`,
				"",
			].join("\n"),
		);
	});

	it("ages out stale failed/dead_letter/cancelled leaf tasks from readable graph output", () => {
		const { dbPath, engine, repo } = setup();
		const db = new Database(dbPath);

		// stale failed leaf — should be hidden (completed_at > 1 hour ago)
		const staleFailedTask = enqueueTask(engine, {
			title: "stale failed leaf",
			capability: "execute",
			scope: repo,
			chain: "none",
		}).task.id;
		engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		engine.failTask({ taskId: staleFailedTask, runId: "run_war", token: 1, reason: "bad" });
		db.prepare("UPDATE tasks SET completed_at=datetime('now', '-2 hours') WHERE id=?").run(
			staleFailedTask,
		);

		// stale dead_letter leaf — should be hidden (set directly in DB)
		const staleDeadLetterTask = enqueueTask(engine, {
			title: "stale dead_letter leaf",
			capability: "execute",
			scope: repo,
			chain: "none",
		}).task.id;
		db.prepare(
			"UPDATE tasks SET status='dead_letter', completed_at=datetime('now', '-2 hours') WHERE id=?",
		).run(staleDeadLetterTask);

		// stale cancelled leaf — should be hidden after the same 1 hour window
		const staleCancelledTask = enqueueTask(engine, {
			title: "stale cancelled leaf",
			capability: "execute",
			scope: repo,
			chain: "none",
		}).task.id;
		engine.cancel({ taskId: staleCancelledTask, runId: "run_toil", reason: "stale cancel" });
		db.prepare("UPDATE tasks SET completed_at=datetime('now', '-2 hours') WHERE id=?").run(
			staleCancelledTask,
		);

		// recently failed leaf — should remain visible
		engine.runUpsert({
			agent: "war",
			mode: "afk",
			scope: repo,
			cwd: "/tmp/pithos-repo",
			sessionId: "s_war_r2",
			harnessKind: "pi",
			sessionLogPath: "/tmp/s_war_r2.jsonl",
			runId: "run_war_r2",
		});
		const recentFailedTask = enqueueTask(engine, {
			title: "recent failed leaf",
			capability: "execute",
			scope: repo,
			chain: "none",
		}).task.id;
		engine.claim({ runId: "run_war_r2", scope: repo, capability: "execute" });
		engine.failTask({ taskId: recentFailedTask, runId: "run_war_r2", token: 1, reason: "bad" });

		// recently cancelled leaf — should remain visible for the first hour
		const recentCancelledTask = enqueueTask(engine, {
			title: "recent cancelled leaf",
			capability: "execute",
			scope: repo,
			chain: "none",
		}).task.id;
		engine.cancel({ taskId: recentCancelledTask, runId: "run_toil", reason: "recent cancel" });

		// stale failed parent with active child — parent should still appear due to visible descendant
		const staleFailedParent = enqueueTask(engine, {
			title: "stale failed parent",
			capability: "execute",
			scope: repo,
			chain: "none",
		}).task.id;
		db.prepare(
			"UPDATE tasks SET status='failed', completed_at=datetime('now', '-2 hours') WHERE id=?",
		).run(staleFailedParent);
		const activeChild = enqueueTask(engine, {
			title: "active child of stale parent",
			capability: "execute",
			scope: repo,
			dependsOn: [staleFailedParent],
			chain: "none",
		}).task.id;

		// stale failed task that was superseded — should remain visible because its successor is active
		const staleFailedSuperseded = enqueueTask(engine, {
			title: "stale failed superseded",
			capability: "execute",
			scope: repo,
			chain: "none",
		}).task.id;
		db.prepare(
			"UPDATE tasks SET status='failed', completed_at=datetime('now', '-2 hours') WHERE id=?",
		).run(staleFailedSuperseded);
		const activeSuccessor = engine.supersede({
			taskId: staleFailedSuperseded,
			runId: "run_toil",
			reason: "retry",
			title: "active successor of stale failed",
			body: "body",
			bodyFile: undefined,
			scope: repo,
			capability: "execute",
		}).task.id;

		db.close();

		const graphText = renderGraphInspectText(
			engine.graphInspect({ taskId: undefined, scope: repo, all: false }),
		);

		// stale failed, dead_letter, and cancelled leaf tasks are hidden
		expect(graphText).not.toContain("stale failed leaf");
		expect(graphText).not.toContain("stale dead_letter leaf");
		expect(graphText).not.toContain("stale cancelled leaf");
		// recent terminal failures/cancellations are still visible
		expect(graphText).toContain(`${recentFailedTask} [execute] [failed] recent failed leaf`);
		expect(graphText).toContain(
			`${recentCancelledTask} [execute] [cancelled] recent cancelled leaf`,
		);
		// stale parent remains visible because its dependency child is active
		expect(graphText).toContain(`${staleFailedParent} [execute] [failed] stale failed parent`);
		expect(graphText).toContain(`${activeChild} [execute] [blocked] active child of stale parent`);
		// stale superseded task remains visible because its supersession successor is active
		expect(graphText).toContain(
			`${staleFailedSuperseded} [execute] [failed] stale failed superseded`,
		);
		expect(graphText).toContain(
			`${activeSuccessor} [execute] [queued] active successor of stale failed`,
		);

		const selectedStaleLeafGraphText = renderGraphInspectText(
			engine.graphInspect({ taskId: staleFailedTask, scope: undefined, all: false }),
		);
		expect(selectedStaleLeafGraphText).toContain(
			`- ${staleFailedTask} [execute] [failed] stale failed leaf`,
		);
		// Auto-alert created by failTask appears in the graph via repair_source link
		expect(selectedStaleLeafGraphText).toContain(`Investigate failed task ${staleFailedTask}`);
	});

	it("auto-chains ordinary follow-up to the actor run's held task", () => {
		const { dbPath, engine } = setup();
		const upstream = enqueueTask(engine, { title: "triage upstream" }).task.id;
		const claimed = engine.claim({ runId: "run_toil", scope: "global", capability: "triage" });
		const followUp = enqueueTask(engine, { title: "design follow-up", capability: "design" });

		expect(followUp.chain).toMatchObject({
			applied: "depends_on_held",
			held_task_id: upstream,
			implicit_dependency_ids: [upstream],
			final_dependency_ids: [upstream],
		});
		expect(() =>
			engine.claim({ runId: "run_greed", scope: "global", capability: "design" }),
		).toThrow(PithosError);
		const inspect = engine.taskInspect({ taskId: followUp.task.id });
		expect(inspect.task.unresolved_dependency_ids).toEqual([upstream]);
		expect(inspect.dependencies.map((task) => task.id)).toEqual([upstream]);
		expect(inspect.lineage.map((entry) => entry.task.id)).toEqual([upstream]);
		const eventPayload = JSON.parse(
			new Database(dbPath)
				.prepare("SELECT payload_json FROM events WHERE type='task.created' AND task_id=?")
				.pluck()
				.get(followUp.task.id) as string,
		) as unknown as { chain: { implicit_dependency_ids: readonly string[] } };
		expect(eventPayload.chain.implicit_dependency_ids).toEqual([upstream]);

		engine.complete({
			taskId: upstream,
			runId: "run_toil",
			token: claimed.task.token,
			resultJson: "{}",
		});
		expect(
			engine.claim({ runId: "run_greed", scope: "global", capability: "design" }).task.id,
		).toBe(followUp.task.id);
	});

	it("combines manual fan-in and rejects duplicate final dependencies", () => {
		const { engine } = setup();
		const manual = enqueueTask(engine, { title: "manual blocker" }).task.id;
		const manualClaim = engine.claim({ runId: "run_toil", scope: "global", capability: "triage" });
		engine.complete({
			taskId: manual,
			runId: "run_toil",
			token: manualClaim.task.token,
			resultJson: "{}",
		});
		const held = enqueueTask(engine, { title: "held blocker" }).task.id;
		engine.claim({ runId: "run_toil", scope: "global", capability: "triage" });

		const fanIn = enqueueTask(engine, {
			title: "fan in",
			capability: "design",
			dependsOn: [manual],
		});
		expect(fanIn.chain.final_dependency_ids).toEqual([manual, held]);
		expect(
			engine
				.taskInspect({ taskId: fanIn.task.id })
				.dependencies.map((task) => task.id)
				.sort(),
		).toEqual([held, manual].sort());
		expect(() =>
			enqueueTask(engine, { title: "duplicate", capability: "design", dependsOn: [held] }),
		).toThrow(/duplicate dependency task id/);
	});

	it("requires held ordinary work for explicit held chaining", () => {
		const { engine } = setup();
		expect(() =>
			enqueueTask(engine, { title: "no held", capability: "design", chain: "held" }),
		).toThrow(/--chain held requires a held task/);
		const held = enqueueTask(engine, { title: "held" }).task.id;
		engine.claim({ runId: "run_toil", scope: "global", capability: "triage" });
		expect(() =>
			enqueueTask(engine, { title: "bad escalation", capability: "escalate", chain: "held" }),
		).toThrow(/--chain held cannot be used when enqueueing escalation tasks/);
		expect(
			enqueueTask(engine, { title: "explicit held", capability: "design", chain: "held" }).chain,
		).toMatchObject({ applied: "depends_on_held", final_dependency_ids: [held] });
	});

	it("source-links escalations from held ordinary work without blocking claimability", () => {
		const { dbPath, engine } = setup();
		upsertPandoraRun(engine);
		const source = enqueueTask(engine, { title: "held source" }).task.id;
		engine.claim({ runId: "run_toil", scope: "global", capability: "triage" });

		const escalation = enqueueTask(engine, {
			title: "needs attention",
			capability: "escalate",
			runId: "run_toil",
		});

		expect(escalation.chain).toMatchObject({
			applied: "source_from_held",
			held_task_id: source,
			source_task_id: source,
			implicit_dependency_ids: [],
			final_dependency_ids: [],
		});
		const inspect = engine.taskInspect({ taskId: escalation.task.id });
		expect(inspect.source).toMatchObject({
			id: source,
			scope_id: "global",
			status: "claimed",
			source_kind: "chain_source",
		});
		expect(inspect.dependencies).toEqual([]);
		expect(inspect.lineage).toEqual([]);
		expect(inspect.task.claimable).toBe(true);
		expect(
			engine.claim({ runId: "run_pandora", scope: "global", capability: "escalate" }).task.id,
		).toBe(escalation.task.id);

		const graph = engine.graphInspect({
			taskId: escalation.task.id,
			scope: undefined,
			all: false,
		}) as ReturnType<Engine["graphInspect"]> & {
			graph: {
				nodes: readonly { id: string; source_task_id: string | null; source_kind: string | null }[];
				edges: readonly {
					kind: string;
					from_task_id: string;
					to_task_id: string;
					source_kind?: string;
				}[];
			};
		};
		expect(graph.graph.nodes.map((node) => node.id).sort()).toEqual(
			[escalation.task.id, source].sort(),
		);
		expect(graph.graph.nodes.find((node) => node.id === escalation.task.id)).toMatchObject({
			source_task_id: source,
			source_kind: "chain_source",
		});
		expect(graph.graph.edges).toContainEqual({
			kind: "source",
			from_task_id: escalation.task.id,
			to_task_id: source,
			source_kind: "chain_source",
		});

		const eventPayload = JSON.parse(
			new Database(dbPath)
				.prepare("SELECT payload_json FROM events WHERE type='task.created' AND task_id=?")
				.pluck()
				.get(escalation.task.id) as string,
		) as unknown as { chain: { source_task_id: string | null; source_kind: string | null } };
		expect(eventPayload.chain.source_task_id).toBe(source);
		expect(eventPayload.chain.source_kind).toBe("chain_source");
	});

	it("routes Pandora follow-up from held escalation to its source task", () => {
		const { dbPath, engine } = setup();
		const { source, escalation } = claimSourcedEscalationWithPandora(engine);

		const followUp = enqueueTask(engine, {
			title: "resolution follow-up",
			capability: "design",
			runId: "run_pandora",
		});

		expect(followUp.chain).toMatchObject({
			applied: "depends_on_source",
			held_task_id: escalation,
			source_task_id: source,
			implicit_dependency_ids: [source],
			final_dependency_ids: [source],
		});
		const inspect = engine.taskInspect({ taskId: followUp.task.id });
		expect(inspect.dependencies.map((task) => task.id)).toEqual([source]);
		expect(inspect.task.unresolved_dependency_ids).toEqual([source]);
		expect(taskCreatedChain(dbPath, followUp.task.id)).toMatchObject({
			applied: "depends_on_source",
			source_task_id: source,
			implicit_dependency_ids: [source],
			final_dependency_ids: [source],
		});
	});

	it("rejects ordinary continuation from held repair-source escalations", () => {
		const { dbPath, engine } = setup();
		claimSourcedEscalationWithPandora(engine);
		const db = new Database(dbPath);
		db.prepare("UPDATE task_sources SET kind='repair_source'").run();
		db.close();

		expect(() =>
			enqueueTask(engine, {
				title: "bad auto continuation",
				capability: "design",
				runId: "run_pandora",
			}),
		).toThrow(/--chain auto cannot continue from repair_source; supersede or replan/);
		expect(() =>
			enqueueTask(engine, {
				title: "bad explicit continuation",
				capability: "triage",
				runId: "run_pandora",
				chain: "source",
			}),
		).toThrow(
			/--chain source requires a chain_source; repair_source must be superseded or replanned/,
		);
	});

	it("makes held escalation without source a visible auto-chain no-op", () => {
		const { dbPath, engine } = setup();
		upsertPandoraRun(engine);
		const escalation = enqueueTask(engine, {
			title: "flat escalation",
			capability: "escalate",
			chain: "none",
		}).task.id;
		engine.claim({ runId: "run_pandora", scope: "global", capability: "escalate" });

		const followUp = enqueueTask(engine, {
			title: "unrelated design",
			capability: "design",
			runId: "run_pandora",
		});

		expect(followUp.chain).toMatchObject({
			applied: "flat_held_escalation_without_source",
			held_task_id: escalation,
			source_task_id: null,
			implicit_dependency_ids: [],
			final_dependency_ids: [],
		});
		expect(engine.taskInspect({ taskId: followUp.task.id }).dependencies).toEqual([]);
		expect(taskCreatedChain(dbPath, followUp.task.id)).toMatchObject({
			applied: "flat_held_escalation_without_source",
			held_task_id: escalation,
			source_task_id: null,
			implicit_dependency_ids: [],
			final_dependency_ids: [],
		});
	});

	it("supports explicit source chaining from a held sourced escalation", () => {
		const { dbPath, engine } = setup();
		const { source, escalation } = claimSourcedEscalationWithPandora(engine);

		const followUp = enqueueTask(engine, {
			title: "explicit source follow-up",
			capability: "triage",
			runId: "run_pandora",
			chain: "source",
		});

		expect(followUp.chain).toMatchObject({
			policy: "source",
			applied: "depends_on_source",
			held_task_id: escalation,
			source_task_id: source,
			implicit_dependency_ids: [source],
			final_dependency_ids: [source],
		});
		expect(
			engine.taskInspect({ taskId: followUp.task.id }).dependencies.map((task) => task.id),
		).toEqual([source]);
		expect(taskCreatedChain(dbPath, followUp.task.id)).toMatchObject({
			policy: "source",
			applied: "depends_on_source",
			source_task_id: source,
			implicit_dependency_ids: [source],
			final_dependency_ids: [source],
		});
	});

	it("keeps escalation from held escalation visibly flat", () => {
		const { dbPath, engine } = setup();
		const { escalation } = claimSourcedEscalationWithPandora(engine);

		const nextEscalation = enqueueTask(engine, {
			title: "separate attention",
			capability: "escalate",
			runId: "run_pandora",
		});

		expect(nextEscalation.chain).toMatchObject({
			applied: "flat_escalation_from_escalation",
			held_task_id: escalation,
			source_task_id: null,
			implicit_dependency_ids: [],
			final_dependency_ids: [],
		});
		expect(engine.taskInspect({ taskId: nextEscalation.task.id })).toMatchObject({
			source: null,
			dependencies: [],
		});
		expect(taskCreatedChain(dbPath, nextEscalation.task.id)).toMatchObject({
			applied: "flat_escalation_from_escalation",
			held_task_id: escalation,
			source_task_id: null,
			implicit_dependency_ids: [],
			final_dependency_ids: [],
		});
	});

	it("fails loudly for invalid explicit source chaining", () => {
		const { engine } = setup();
		upsertPandoraRun(engine);
		expect(() =>
			enqueueTask(engine, { title: "no held source", capability: "design", chain: "source" }),
		).toThrow(/--chain source requires a held task/);

		const escalation = enqueueTask(engine, {
			title: "flat escalation",
			capability: "escalate",
			chain: "none",
		}).task.id;
		engine.claim({ runId: "run_pandora", scope: "global", capability: "escalate" });
		expect(() =>
			enqueueTask(engine, {
				title: "no source",
				capability: "design",
				runId: "run_pandora",
				chain: "source",
			}),
		).toThrow(/--chain source requires the held task to have a source link/);
		expect(() =>
			enqueueTask(engine, {
				title: "bad escalation",
				capability: "escalate",
				runId: "run_pandora",
				chain: "source",
			}),
		).toThrow(/--chain source cannot be used when enqueueing escalation tasks/);
		expect(engine.taskInspect({ taskId: escalation }).task.status).toBe("claimed");
	});

	it("keeps chain none manual-only while Pandora holds a sourced escalation", () => {
		const { dbPath, engine } = setup();
		const { escalation } = claimSourcedEscalationWithPandora(engine);
		const manual = enqueueTask(engine, {
			title: "manual dependency",
			capability: "triage",
			runId: "run_greed",
			chain: "none",
		}).task.id;

		const followUp = enqueueTask(engine, {
			title: "manual-only follow-up",
			capability: "design",
			runId: "run_pandora",
			dependsOn: [manual],
			chain: "none",
		});

		expect(followUp.chain).toMatchObject({
			applied: "none_selected",
			held_task_id: escalation,
			source_task_id: null,
			implicit_dependency_ids: [],
			final_dependency_ids: [manual],
		});
		expect(
			engine.taskInspect({ taskId: followUp.task.id }).dependencies.map((task) => task.id),
		).toEqual([manual]);
		expect(taskCreatedChain(dbPath, followUp.task.id)).toMatchObject({
			applied: "none_selected",
			held_task_id: escalation,
			source_task_id: null,
			implicit_dependency_ids: [],
			final_dependency_ids: [manual],
		});
	});

	it("fails loudly before source-linking a superseded held source", () => {
		const { dbPath, engine } = setup();
		const source = enqueueTask(engine, { title: "held source" }).task.id;
		engine.claim({ runId: "run_toil", scope: "global", capability: "triage" });
		const replacement = enqueueTask(engine, { title: "replacement", runId: "run_toil" }).task.id;
		const db = new Database(dbPath);
		db.prepare(
			"INSERT INTO task_supersessions(old_task_id,new_task_id,created_by_run_id,reason) VALUES (?,?,?,?)",
		).run(source, replacement, "run_toil", "test supersession");
		db.close();

		expect(() =>
			enqueueTask(engine, { title: "needs attention", capability: "escalate", runId: "run_toil" }),
		).toThrow(`source task ${source} was superseded by ${replacement}`);
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
			chain: "auto",
		}).task.id;
		engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		expect(() => engine.heartbeat({ runId: "run_war", taskId: task, token: undefined })).toThrow(
			PithosError,
		);
		expect(() =>
			engine.complete({ taskId: task, runId: "run_war", token: 99, resultJson: "{}" }),
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
			chain: "auto",
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
			chain: "auto",
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

	it("launch-aborts no-claim live runs without mutating tasks", () => {
		const { dbPath, engine } = setup();

		expect(
			engine.runLaunchAbort({ runId: "run_war", reason: "launch_precondition_failed" }),
		).toMatchObject({
			ok: true,
			run: {
				id: "run_war",
				status: "cancelled",
				task_id: null,
				harness_kind: "pi",
				session_log_path: "/tmp/s_war.jsonl",
			},
		});

		const db = new Database(dbPath);
		expect(db.prepare("SELECT COUNT(*) FROM tasks").pluck().get()).toBe(0);
		const aborted = JSON.parse(
			db
				.prepare("SELECT payload_json FROM events WHERE type='run.launch_aborted' AND run_id=?")
				.pluck()
				.get("run_war") as string,
		) as unknown as { reason: string; previous_status: string; status: string };
		expect(aborted).toEqual({
			reason: "launch_precondition_failed",
			previous_status: "live",
			status: "cancelled",
		});
		db.close();
	});

	it("rejects launch-abort for runs that hold or held tasks", () => {
		const { engine, repo } = setup();
		const held = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "held launch abort reject",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		expect(() => engine.runLaunchAbort({ runId: "run_war", reason: "bad launch" })).toThrow(
			/launch abort requires no held task/,
		);
		engine.complete({ taskId: held, runId: "run_war", token: 1, resultJson: "{}" });
		expect(() => engine.runLaunchAbort({ runId: "run_war", reason: "bad launch" })).toThrow(
			/launch abort requires a run that has never claimed a task/,
		);
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
			chain: "auto",
		}).task.id;
		engine.claim({ runId: "run_war2", scope: repo, capability: "execute" });
		expect(() => engine.runTimeout({ runId: "run_war2", reason: "no claim" })).toThrow(PithosError);
		engine.complete({ taskId: held, runId: "run_war2", token: 1, resultJson: "{}" });
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
			chain: "auto",
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
			chain: "auto",
		}).task.id;
		engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		expect(() => engine.cancel({ taskId: held, runId: "run_toil", reason: "bad" })).toThrow(
			/use pdx kill or pithos run interrupt/,
		);
	});

	it("atomically cancels an unlaunchable queued task and creates a Repair Alert", () => {
		const { dbPath, engine, repo } = setup();
		const original = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "unlaunchable work",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;

		const result = engine.escalateLaunchPrecondition({
			runId: "run_pdx",
			expectedTaskId: original,
			expectedScopeId: repo,
			expectedCapability: "execute",
			canonicalPath: "/tmp/pithos-repo",
			agentKind: "war",
			reason: "scope_cwd_missing_at_launch",
			escalationTitle: "Launch precondition failed",
			escalationBody: "The repo cwd was missing before launch.",
		});

		expect(result).toMatchObject({
			ok: true,
			task: { id: original, status: "cancelled" },
			escalation: {
				status: "queued",
				scope_id: "global",
				capability: "escalate",
				source_task_id: original,
				source_kind: "repair_source",
			},
		});
		expect(engine.taskInspect({ taskId: original }).task.status).toBe("cancelled");
		expect(engine.taskInspect({ taskId: result.escalation.id })).toMatchObject({
			task: { id: result.escalation.id, status: "queued", scope_id: "global" },
			source: { id: original, source_kind: "repair_source" },
			dependencies: [],
		});

		const db = new Database(dbPath);
		expect(
			db
				.prepare(
					"SELECT kind FROM task_sources WHERE task_id=? AND source_task_id=? AND source_run_id=?",
				)
				.pluck()
				.get(result.escalation.id, original, "run_pdx"),
		).toBe("repair_source");
		const created = JSON.parse(
			db
				.prepare("SELECT payload_json FROM events WHERE type='task.created' AND task_id=?")
				.pluck()
				.get(result.escalation.id) as string,
		) as { source_kind: string; source_task_id: string };
		expect(created).toMatchObject({ source_task_id: original, source_kind: "repair_source" });
		db.close();
	});

	it("creates a pdx-authored repair alert with repair source provenance", () => {
		const { dbPath, engine, repo } = setup();
		const affected = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "interrupted work",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		engine.runInterrupt({ runId: "run_war", taskId: undefined, reason: "operator kill" });

		const result = engine.createRepairAlert({
			runId: "run_pdx",
			affectedTaskId: affected,
			kind: "interrupt",
			escalationTitle: "Interrupted run requires attention",
			escalationBody: "The run was interrupted and needs repair.",
		});

		expect(result).toMatchObject({
			ok: true,
			escalation: {
				status: "queued",
				scope_id: "global",
				capability: "escalate",
				source_task_id: affected,
				source_kind: "repair_source",
				kind: "interrupt",
			},
		});
		expect(engine.taskInspect({ taskId: result.escalation.id })).toMatchObject({
			task: { id: result.escalation.id, status: "queued", scope_id: "global" },
			source: { id: affected, status: "failed", source_kind: "repair_source" },
			dependencies: [],
			repair_alert_kind: "interrupt",
		});
		const graph = engine.graphInspect({
			taskId: result.escalation.id,
			scope: undefined,
			all: false,
		});
		expect(graph.graph.edges).toContainEqual({
			kind: "source",
			from_task_id: result.escalation.id,
			to_task_id: affected,
			source_kind: "repair_source",
		});

		const db = new Database(dbPath);
		expect(
			db
				.prepare(
					"SELECT kind FROM task_sources WHERE task_id=? AND source_task_id=? AND source_run_id=?",
				)
				.pluck()
				.get(result.escalation.id, affected, "run_pdx"),
		).toBe("repair_source");
		expect(
			db
				.prepare("SELECT kind FROM repair_alerts WHERE task_id=?")
				.pluck()
				.get(result.escalation.id),
		).toBe("interrupt");
		const created = JSON.parse(
			db
				.prepare("SELECT payload_json FROM events WHERE type='task.created' AND task_id=?")
				.pluck()
				.get(result.escalation.id) as string,
		) as { source_kind: string; source_task_id: string };
		expect(created).toMatchObject({ source_task_id: affected, source_kind: "repair_source" });
		db.close();
	});

	it("rolls back repair alert creation when affected task is missing", () => {
		const { dbPath, engine } = setup();
		expect(() =>
			engine.createRepairAlert({
				runId: "run_pdx",
				affectedTaskId: "task_missing",
				kind: "task_failed",
				escalationTitle: "Missing source",
				escalationBody: "This should not be persisted.",
			}),
		).toThrow(PithosError);

		const db = new Database(dbPath);
		expect(db.prepare("SELECT COUNT(*) FROM tasks WHERE capability='escalate'").pluck().get()).toBe(
			0,
		);
		expect(db.prepare("SELECT COUNT(*) FROM task_sources").pluck().get()).toBe(0);
		db.close();
	});

	it("rolls back repair alert creation for non-pdx actors", () => {
		const { dbPath, engine, repo } = setup();
		const affected = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "affected work",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;

		expect(() =>
			engine.createRepairAlert({
				runId: "run_toil",
				affectedTaskId: affected,
				kind: "task_failed",
				escalationTitle: "Bad actor",
				escalationBody: "This should not be persisted.",
			}),
		).toThrow(/repair alert must be authored by pdx/);

		const db = new Database(dbPath);
		expect(db.prepare("SELECT COUNT(*) FROM tasks WHERE capability='escalate'").pluck().get()).toBe(
			0,
		);
		expect(db.prepare("SELECT COUNT(*) FROM task_sources").pluck().get()).toBe(0);
		db.close();
	});

	it("sets completed_at on task complete, dead_letter, and cancel terminal transitions", () => {
		const { dbPath, engine, repo } = setup();
		const db = new Database(dbPath);

		// complete sets completed_at
		const completeTask = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "complete me",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		engine.claim({ runId: "run_war", scope: repo, capability: "execute" });
		expect(
			db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(completeTask),
		).toBeNull();
		engine.complete({ taskId: completeTask, runId: "run_war", token: 1, resultJson: "{}" });
		expect(
			db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(completeTask),
		).toBeTruthy();

		// dead_letter via runCleanup sets completed_at
		engine.runUpsert({
			agent: "war",
			mode: "afk",
			scope: repo,
			cwd: "/tmp/pithos-repo",
			sessionId: "s_war_dl",
			harnessKind: "pi",
			sessionLogPath: "/tmp/s_war_dl.jsonl",
			runId: "run_war_dl",
		});
		const dlTask = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "dead letter me",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		engine.claim({ runId: "run_war_dl", scope: repo, capability: "execute" });
		db.prepare("UPDATE tasks SET attempts=max_attempts WHERE id=?").run(dlTask);
		expect(db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(dlTask)).toBeNull();
		engine.runCleanup({ runId: "run_war_dl", reason: "process exited" });
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(dlTask)).toBe(
			"dead_letter",
		);
		expect(
			db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(dlTask),
		).toBeTruthy();

		// reclaim (not yet dead_letter) leaves completed_at null
		engine.runUpsert({
			agent: "war",
			mode: "afk",
			scope: repo,
			cwd: "/tmp/pithos-repo",
			sessionId: "s_war_rc",
			harnessKind: "pi",
			sessionLogPath: "/tmp/s_war_rc.jsonl",
			runId: "run_war_rc",
		});
		const reclaimTask = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "reclaim me",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		engine.claim({ runId: "run_war_rc", scope: repo, capability: "execute" });
		engine.runCleanup({ runId: "run_war_rc", reason: "process exited" });
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(reclaimTask)).toBe(
			"queued",
		);
		expect(
			db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(reclaimTask),
		).toBeNull();

		// cancel of queued task sets completed_at
		const cancelTask = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "cancel me",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		expect(
			db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(cancelTask),
		).toBeNull();
		engine.cancel({ taskId: cancelTask, runId: "run_toil", reason: "not needed" });
		expect(
			db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(cancelTask),
		).toBeTruthy();

		// cancel of dead_letter preserves original completed_at
		const dlCompletedAt = db
			.prepare("SELECT completed_at FROM tasks WHERE id=?")
			.pluck()
			.get(dlTask) as string;
		engine.cancel({ taskId: dlTask, runId: "run_toil", reason: "cleaning up" });
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(dlTask)).toBe("cancelled");
		expect(db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(dlTask)).toBe(
			dlCompletedAt,
		);

		db.close();
	});

	it("sets completed_at when supersede cancels the queued original", () => {
		const { dbPath, engine, repo } = setup();
		const original = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "original",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		const db = new Database(dbPath);
		expect(
			db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(original),
		).toBeNull();
		engine.supersede({
			taskId: original,
			runId: "run_toil",
			reason: "redesign",
			title: "replacement",
			body: "body",
			bodyFile: undefined,
			scope: undefined,
			capability: undefined,
		});
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(original)).toBe(
			"cancelled",
		);
		expect(
			db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(original),
		).toBeTruthy();
		db.close();
	});

	it("sets completed_at when escalateLaunchPrecondition cancels the queued task", () => {
		const { dbPath, engine, repo } = setup();
		const original = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "unlaunchable",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		const db = new Database(dbPath);
		expect(
			db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(original),
		).toBeNull();
		engine.escalateLaunchPrecondition({
			runId: "run_pdx",
			expectedTaskId: original,
			expectedScopeId: repo,
			expectedCapability: "execute",
			canonicalPath: "/tmp/pithos-repo",
			agentKind: "war",
			reason: "scope_cwd_missing_at_launch",
			escalationTitle: "Launch precondition failed",
			escalationBody: "The repo cwd was missing before launch.",
		});
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(original)).toBe(
			"cancelled",
		);
		expect(
			db.prepare("SELECT completed_at FROM tasks WHERE id=?").pluck().get(original),
		).toBeTruthy();
		db.close();
	});

	it("rolls back launch-precondition repair when expected task preconditions changed", () => {
		const { dbPath, engine, repo } = setup();
		const original = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "race work",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;

		expect(() =>
			engine.escalateLaunchPrecondition({
				runId: "run_pdx",
				expectedTaskId: original,
				expectedScopeId: repo,
				expectedCapability: "design",
				canonicalPath: "/tmp/pithos-repo",
				agentKind: "war",
				reason: "scope_cwd_missing_at_launch",
				escalationTitle: "Launch precondition failed",
				escalationBody: "The repo cwd was missing before launch.",
			}),
		).toThrow(PithosError);

		const db = new Database(dbPath);
		expect(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(original)).toBe("queued");
		expect(db.prepare("SELECT COUNT(*) FROM tasks WHERE capability='escalate'").pluck().get()).toBe(
			0,
		);
		expect(db.prepare("SELECT COUNT(*) FROM task_sources").pluck().get()).toBe(0);
		db.close();
	});

	it("shows upstream lineage details, artifacts, and supersession metadata without siblings", () => {
		const { dbPath, engine, repo } = setup();
		const triage = engine.enqueue({
			scope: "global",
			capability: "triage",
			title: "triage",
			body: "triage body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [],
			chain: "auto",
		}).task.id;
		const oldDesign = engine.enqueue({
			scope: "global",
			capability: "design",
			title: "old design",
			body: "old design body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [triage],
			chain: "auto",
		}).task.id;
		const branchDesign = engine.enqueue({
			scope: "global",
			capability: "design",
			title: "branch design",
			body: "branch design body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [triage],
			chain: "auto",
		}).task.id;
		const replacement = engine.supersede({
			taskId: oldDesign,
			runId: "run_toil",
			reason: "approved revision",
			title: "approved design",
			body: "approved design body",
			bodyFile: undefined,
			scope: undefined,
			capability: undefined,
		}) as { task: { id: string } };
		engine.artifactAdd({
			taskId: replacement.task.id,
			runId: "run_toil",
			kind: "design-brief",
			title: "approved brief",
			body: "design brief body",
		});
		const execute = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "implement",
			body: "execute body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [replacement.task.id, branchDesign],
			chain: "auto",
		}).task.id;
		const sibling = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "parallel implement",
			body: "parallel body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [replacement.task.id],
			chain: "auto",
		}).task.id;
		const db = new Database(dbPath);
		const setCreatedAt = db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?");
		for (const [createdAt, taskId] of [
			["2026-05-08 00:00:01", triage],
			["2026-05-08 00:00:02", oldDesign],
			["2026-05-08 00:00:03", branchDesign],
			["2026-05-08 00:00:04", replacement.task.id],
			["2026-05-08 00:00:05", execute],
			["2026-05-08 00:00:06", sibling],
		] as const) {
			setCreatedAt.run(createdAt, createdAt, taskId);
		}
		db.close();

		const inspect = engine.taskInspect({ taskId: execute });
		expect(inspect.task).toMatchObject({
			id: execute,
			body: "execute body",
			fencing_token: 0,
			attempts: 0,
			max_attempts: 3,
			claimable: false,
		});
		expect(inspect.dependencies.map((task) => task.id)).toEqual([
			branchDesign,
			replacement.task.id,
		]);
		expect(inspect.lineage.map((entry) => ({ depth: entry.depth, id: entry.task.id }))).toEqual([
			{ depth: 2, id: triage },
			{ depth: 1, id: branchDesign },
			{ depth: 1, id: replacement.task.id },
		]);
		expect(inspect.lineage[0]).toMatchObject({
			depth: 2,
			via_task_ids: [branchDesign, replacement.task.id],
			task: {
				id: triage,
				body: "triage body",
				claimable: true,
				unresolved_dependency_ids: [],
			},
			artifacts: [],
			supersedes: null,
			superseded_by: null,
		});
		expect(inspect.lineage[1]).toMatchObject({
			depth: 1,
			via_task_ids: [execute],
			task: {
				id: branchDesign,
				body: "branch design body",
				unresolved_dependency_ids: [triage],
			},
			supersedes: null,
			superseded_by: null,
			artifacts: [],
		});
		expect(inspect.lineage[2]).toMatchObject({
			depth: 1,
			via_task_ids: [execute],
			task: {
				id: replacement.task.id,
				body: "approved design body",
				unresolved_dependency_ids: [triage],
			},
			supersedes: oldDesign,
			superseded_by: null,
			artifacts: [
				{
					kind: "design-brief",
					title: "approved brief",
					body: "design brief body",
				},
			],
		});
		expect(inspect.lineage.some((entry) => entry.task.id === oldDesign)).toBe(false);
		expect(inspect.lineage.some((entry) => entry.task.id === sibling)).toBe(false);
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
			chain: "auto",
		}).task.id;
		const downstream = engine.enqueue({
			scope: repo,
			capability: "execute",
			title: "downstream",
			body: "body",
			bodyFile: undefined,
			runId: "run_toil",
			dependsOn: [blocker],
			chain: "auto",
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
