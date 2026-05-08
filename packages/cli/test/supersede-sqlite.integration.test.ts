import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { claimCommand } from "../src/commands/claim.ts";
import { enqueueCommand } from "../src/commands/enqueue.ts";
import { failCommand } from "../src/commands/fail.ts";
import { initCommand } from "../src/commands/init.ts";
import { inspectTaskCommand } from "../src/commands/inspect.ts";
import { runRegisterCommand } from "../src/commands/run.ts";
import { supersedeCommand } from "../src/commands/supersede.ts";
import { scopeUpsertCommand } from "../src/commands/scope.ts";
import { makeDbServiceLive } from "../src/layers/db.ts";
import { FsServiceLive } from "../src/layers/fs.ts";
import { makeIdServiceTest } from "../src/layers/ids.ts";
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts";

const silentOutput = makeOutputServiceSilent();

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pithos-supersede-"));
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
	return Effect.runPromiseExit(effect);
}

describe("supersedeCommand (integration — real SQLite)", () => {
	let tempDir: string;
	let dbPath: string;
	let dbLayer: ReturnType<typeof makeDbServiceLive>;

	beforeEach(async () => {
		tempDir = makeTempDir();
		dbPath = join(tempDir, "pithos.sqlite");
		dbLayer = makeDbServiceLive(dbPath);
		await Effect.runPromise(Effect.provide(initCommand, Layer.merge(dbLayer, silentOutput)));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const makeLayer = (ids: string[] = ["task_generated"]) =>
		Layer.mergeAll(dbLayer, makeIdServiceTest(ids), FsServiceLive, silentOutput);

	const registerRun = async (runId: string): Promise<void> => {
		await Effect.runPromise(
			Effect.provide(
				runRegisterCommand({ agentKind: "envy", run: runId }),
				Layer.mergeAll(dbLayer, makeIdServiceTest([runId]), FsServiceLive, silentOutput),
			),
		);
	};

	const upsertRepoScope = async (pathSuffix: string): Promise<string> => {
		const out = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(
				scopeUpsertCommand({ kind: "repo", path: join(tempDir, pathSuffix) }),
				Layer.merge(dbLayer, out.layer),
			),
		);
		const parsed = JSON.parse(out.lines()[0]!) as { ok: boolean; scope: { id: string } };
		expect(parsed.ok).toBe(true);
		return parsed.scope.id;
	};

	const enqueue = async (
		taskId: string,
		opts: {
			scope?: string;
			capability?: string;
			title?: string;
			body?: string;
			run?: string;
			dependsOn?: readonly string[];
		} = {},
	): Promise<void> => {
		await Effect.runPromise(
			Effect.provide(
				enqueueCommand({
					scope: opts.scope ?? "global",
					capability: opts.capability ?? "triage",
					title: opts.title ?? `Task ${taskId}`,
					body: opts.body,
					run: opts.run,
					dependsOn: opts.dependsOn,
				}),
				makeLayer([taskId]),
			),
		);
	};

	it("rewrites a -> b -> c to a -> d -> c, cancels queued old task, and exposes supersession links in inspect", async () => {
		const oldScopeId = await upsertRepoScope("repo-old");
		const newScopeId = await upsertRepoScope("repo-new");
		const bodyPath = join(tempDir, "replacement.md");
		writeFileSync(bodyPath, "Replacement body from file");

		await registerRun("run_actor");
		await enqueue("task_a", {
			scope: "global",
			capability: "design",
			title: "Design blocker",
		});
		await enqueue("task_b", {
			scope: oldScopeId,
			capability: "build",
			title: "Original middle task",
			body: "Old body",
		});
		await enqueue("task_c", {
			scope: "global",
			capability: "build",
			title: "Downstream queued dependent",
			dependsOn: ["task_b"],
		});
		await enqueue("task_cancelled_child", {
			scope: "global",
			capability: "build",
			title: "Cancelled dependent",
			dependsOn: ["task_b"],
		});

		const setupDb = new Database(dbPath);
		setupDb
			.prepare(
				`INSERT INTO task_dependencies (task_id, depends_on_task_id)
         VALUES ('task_b', 'task_a')`,
			)
			.run();
		setupDb
			.prepare(
				`UPDATE tasks
         SET payload_json = '{"source":"old"}',
             max_attempts = 9,
             lease_owner_run_id = 'run_actor',
             lease_until = '2026-05-06T00:00:00Z',
             fencing_token = 5,
             attempts = 4,
             result_json = '{"stale":true}',
             completed_at = '2026-05-05T00:00:00Z'
         WHERE id = 'task_b'`,
			)
			.run();
		setupDb
			.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = 'task_cancelled_child'`)
			.run();
		setupDb.close();

		const out = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(
				supersedeCommand({
					taskId: "task_b",
					run: "run_actor",
					reason: "Wrong middle task",
					title: "Replacement middle task",
					bodyFile: bodyPath,
					scope: newScopeId,
					capability: "review",
				}),
				Layer.mergeAll(dbLayer, makeIdServiceTest(["task_d"]), FsServiceLive, out.layer),
			),
		);

		const parsed = JSON.parse(out.lines()[0]!) as {
			ok: boolean;
			task: { id: string; status: string; scope_id: string; capability: string };
			supersession: {
				old_task_id: string;
				new_task_id: string;
				retargeted_dependent_task_ids: string[];
			};
		};

		expect(parsed).toEqual({
			ok: true,
			task: {
				id: "task_d",
				status: "queued",
				scope_id: newScopeId,
				capability: "review",
			},
			supersession: {
				old_task_id: "task_b",
				new_task_id: "task_d",
				retargeted_dependent_task_ids: ["task_c"],
			},
		});

		const db = new Database(dbPath);
		const oldTask = db
			.prepare(
				`SELECT id, status, scope_id, capability, title, body, payload_json, max_attempts,
                lease_owner_run_id, lease_until, fencing_token, attempts, result_json,
                created_by_run_id, completed_at
         FROM tasks
         WHERE id = 'task_b'`,
			)
			.get() as {
			id: string;
			status: string;
			scope_id: string;
			capability: string;
			title: string;
			body: string;
			payload_json: string;
			max_attempts: number;
			lease_owner_run_id: string | null;
			lease_until: string | null;
			fencing_token: number;
			attempts: number;
			result_json: string;
			created_by_run_id: string | null;
			completed_at: string | null;
		};
		const newTask = db
			.prepare(
				`SELECT id, status, scope_id, capability, title, body, payload_json, max_attempts,
                lease_owner_run_id, lease_until, fencing_token, attempts, result_json,
                created_by_run_id, completed_at
         FROM tasks
         WHERE id = 'task_d'`,
			)
			.get() as {
			id: string;
			status: string;
			scope_id: string;
			capability: string;
			title: string;
			body: string;
			payload_json: string;
			max_attempts: number;
			lease_owner_run_id: string | null;
			lease_until: string | null;
			fencing_token: number;
			attempts: number;
			result_json: string;
			created_by_run_id: string | null;
			completed_at: string | null;
		};
		const dependencyRows = db
			.prepare(
				`SELECT task_id, depends_on_task_id
         FROM task_dependencies
         ORDER BY task_id ASC, depends_on_task_id ASC`,
			)
			.all() as { task_id: string; depends_on_task_id: string }[];
		const supersessionRow = db
			.prepare(
				`SELECT old_task_id, new_task_id, created_by_run_id, reason
         FROM task_supersessions`,
			)
			.get() as {
			old_task_id: string;
			new_task_id: string;
			created_by_run_id: string | null;
			reason: string;
		};
		const graphEvents = db
			.prepare(
				`SELECT task_id, type, payload_json
         FROM events
         WHERE type IN ('task.created', 'task.cancelled', 'task.superseded')
         ORDER BY id ASC`,
			)
			.all() as { task_id: string | null; type: string; payload_json: string }[];
		db.close();

		expect(oldTask.status).toBe("cancelled");
		expect(newTask).toMatchObject({
			id: "task_d",
			status: "queued",
			scope_id: newScopeId,
			capability: "review",
			title: "Replacement middle task",
			body: "Replacement body from file",
			payload_json: '{"source":"old"}',
			max_attempts: 9,
			lease_owner_run_id: null,
			lease_until: null,
			fencing_token: 0,
			attempts: 0,
			result_json: "{}",
			created_by_run_id: "run_actor",
			completed_at: null,
		});
		expect(dependencyRows).toEqual([
			{ task_id: "task_c", depends_on_task_id: "task_d" },
			{ task_id: "task_cancelled_child", depends_on_task_id: "task_b" },
			{ task_id: "task_d", depends_on_task_id: "task_a" },
		]);
		expect(supersessionRow).toEqual({
			old_task_id: "task_b",
			new_task_id: "task_d",
			created_by_run_id: "run_actor",
			reason: "Wrong middle task",
		});

		const createdEvent = graphEvents.find(
			(event) => event.type === "task.created" && event.task_id === "task_d",
		);
		const cancelledEvent = graphEvents.find(
			(event) => event.type === "task.cancelled" && event.task_id === "task_b",
		);
		const supersededEvent = graphEvents.find(
			(event) => event.type === "task.superseded" && event.task_id === "task_b",
		);

		expect(createdEvent).toBeDefined();
		expect(JSON.parse(createdEvent?.payload_json ?? "{}")).toEqual({
			scope_id: newScopeId,
			capability: "review",
			title: "Replacement middle task",
			depends_on_task_ids: ["task_a"],
			supersedes_task_id: "task_b",
		});
		expect(cancelledEvent).toBeDefined();
		expect(JSON.parse(cancelledEvent?.payload_json ?? "{}")).toEqual({
			reason: "Wrong middle task",
			superseded_by_task_id: "task_d",
		});
		expect(supersededEvent).toBeDefined();
		expect(JSON.parse(supersededEvent?.payload_json ?? "{}")).toEqual({
			new_task_id: "task_d",
			reason: "Wrong middle task",
			retargeted_dependent_task_ids: ["task_c"],
		});

		const oldInspectOut = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(inspectTaskCommand("task_b"), Layer.merge(dbLayer, oldInspectOut.layer)),
		);
		const oldInspect = JSON.parse(oldInspectOut.lines()[0]!) as {
			superseded_by: { id: string; scope_id: string; status: string; title: string } | null;
		};

		const newInspectOut = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(inspectTaskCommand("task_d"), Layer.merge(dbLayer, newInspectOut.layer)),
		);
		const newInspect = JSON.parse(newInspectOut.lines()[0]!) as {
			supersedes: { id: string; scope_id: string; status: string; title: string } | null;
		};

		const childInspectOut = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(inspectTaskCommand("task_c"), Layer.merge(dbLayer, childInspectOut.layer)),
		);
		const childInspect = JSON.parse(childInspectOut.lines()[0]!) as {
			task: { claimable: boolean; unresolved_dependency_ids: string[] };
			dependencies: { id: string; scope_id: string; status: string; title: string }[];
		};

		expect(oldInspect.superseded_by).toEqual({
			id: "task_d",
			scope_id: newScopeId,
			status: "queued",
			title: "Replacement middle task",
		});
		expect(newInspect.supersedes).toEqual({
			id: "task_b",
			scope_id: oldScopeId,
			status: "cancelled",
			title: "Original middle task",
		});
		expect(childInspect.task.claimable).toBe(false);
		expect(childInspect.task.unresolved_dependency_ids).toEqual(["task_d"]);
		expect(childInspect.dependencies).toEqual([
			{
				id: "task_d",
				scope_id: newScopeId,
				status: "queued",
				title: "Replacement middle task",
			},
		]);
	});

	it("fails USER_ERROR when the old task is claimed", async () => {
		await registerRun("run_actor");
		await registerRun("run_worker");
		await enqueue("task_old");

		await Effect.runPromise(
			Effect.provide(
				claimCommand({ run: "run_worker", scope: "global", capability: "triage" }),
				Layer.merge(dbLayer, silentOutput),
			),
		);

		const exit = await runEff(
			Effect.provide(
				supersedeCommand({
					taskId: "task_old",
					run: "run_actor",
					reason: "Cannot replace a claimed task",
				}),
				makeLayer(["task_new"]),
			),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const cause = Exit.isFailure(exit) ? String(exit.cause) : "";
		expect(cause).toContain("Cannot supersede task task_old while it is claimed");

		const db = new Database(dbPath);
		const taskIds = db.prepare(`SELECT id FROM tasks ORDER BY id ASC`).all() as { id: string }[];
		const supersessionCount = db
			.prepare(`SELECT COUNT(*) AS count FROM task_supersessions`)
			.get() as { count: number };
		db.close();

		expect(taskIds).toEqual([{ id: "task_old" }]);
		expect(supersessionCount.count).toBe(0);
	});

	it("fails loudly when any direct dependent has already left queued", async () => {
		await registerRun("run_actor");
		await registerRun("run_worker");
		await enqueue("task_old");
		await enqueue("task_child", { dependsOn: ["task_old"] });

		const db = new Database(dbPath);
		db.prepare(
			`UPDATE tasks
       SET status = 'claimed', lease_owner_run_id = 'run_worker', fencing_token = 1
       WHERE id = 'task_child'`,
		).run();
		db.close();

		const exit = await runEff(
			Effect.provide(
				supersedeCommand({
					taskId: "task_old",
					run: "run_actor",
					reason: "Child already started",
				}),
				makeLayer(["task_new"]),
			),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const cause = Exit.isFailure(exit) ? String(exit.cause) : "";
		expect(cause).toContain("direct dependents have already left queued: task_child (claimed)");

		const postDb = new Database(dbPath);
		const dependencyRows = postDb
			.prepare(
				`SELECT task_id, depends_on_task_id
         FROM task_dependencies
         ORDER BY task_id ASC, depends_on_task_id ASC`,
			)
			.all() as { task_id: string; depends_on_task_id: string }[];
		const supersessionCount = postDb
			.prepare(`SELECT COUNT(*) AS count FROM task_supersessions`)
			.get() as { count: number };
		postDb.close();

		expect(dependencyRows).toEqual([{ task_id: "task_child", depends_on_task_id: "task_old" }]);
		expect(supersessionCount.count).toBe(0);
	});

	it("fails USER_ERROR when the old task was already superseded", async () => {
		await registerRun("run_actor");
		await enqueue("task_old");
		await enqueue("task_existing_replacement");

		const db = new Database(dbPath);
		db.prepare(
			`INSERT INTO task_supersessions (old_task_id, new_task_id, created_by_run_id, reason)
       VALUES ('task_old', 'task_existing_replacement', 'run_actor', 'already replaced')`,
		).run();
		db.close();

		const exit = await runEff(
			Effect.provide(
				supersedeCommand({
					taskId: "task_old",
					run: "run_actor",
					reason: "Trying again",
				}),
				makeLayer(["task_new"]),
			),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const cause = Exit.isFailure(exit) ? String(exit.cause) : "";
		expect(cause).toContain(
			"Task task_old has already been superseded by task_existing_replacement",
		);

		const postDb = new Database(dbPath);
		const taskIds = postDb.prepare(`SELECT id FROM tasks ORDER BY id ASC`).all() as {
			id: string;
		}[];
		postDb.close();

		expect(taskIds).toEqual([{ id: "task_existing_replacement" }, { id: "task_old" }]);
	});

	it("resets operational fields when superseding a failed task without cancelling it", async () => {
		await registerRun("run_actor");
		await registerRun("run_worker");
		await enqueue("task_upstream");
		await enqueue("task_old", { dependsOn: ["task_upstream"] });
		await enqueue("task_child", { dependsOn: ["task_old"] });

		const setupDb = new Database(dbPath);
		setupDb.prepare(`UPDATE tasks SET status = 'done' WHERE id = 'task_upstream'`).run();
		setupDb
			.prepare(
				`UPDATE tasks SET payload_json = '{"copied":true}', max_attempts = 7 WHERE id = 'task_old'`,
			)
			.run();
		setupDb.close();

		await Effect.runPromise(
			Effect.provide(
				claimCommand({ run: "run_worker", scope: "global", capability: "triage" }),
				Layer.merge(dbLayer, silentOutput),
			),
		);
		await Effect.runPromise(
			Effect.provide(
				failCommand({
					taskId: "task_old",
					run: "run_worker",
					token: 1,
					reason: "bad intermediate output",
				}),
				Layer.merge(dbLayer, silentOutput),
			),
		);

		await Effect.runPromise(
			Effect.provide(
				supersedeCommand({
					taskId: "task_old",
					run: "run_actor",
					reason: "Retry with corrected instructions",
				}),
				makeLayer(["task_new"]),
			),
		);

		const db = new Database(dbPath);
		const oldTask = db
			.prepare(
				`SELECT status, attempts, fencing_token, result_json FROM tasks WHERE id = 'task_old'`,
			)
			.get() as { status: string; attempts: number; fencing_token: number; result_json: string };
		const newTask = db
			.prepare(
				`SELECT status, attempts, fencing_token, result_json, payload_json, max_attempts, created_by_run_id, completed_at
         FROM tasks WHERE id = 'task_new'`,
			)
			.get() as {
			status: string;
			attempts: number;
			fencing_token: number;
			result_json: string;
			payload_json: string;
			max_attempts: number;
			created_by_run_id: string | null;
			completed_at: string | null;
		};
		const cancelledEvents = db
			.prepare(
				`SELECT COUNT(*) AS count FROM events WHERE task_id = 'task_old' AND type = 'task.cancelled'`,
			)
			.get() as { count: number };
		const dependencyRows = db
			.prepare(
				`SELECT task_id, depends_on_task_id
         FROM task_dependencies
         WHERE task_id IN ('task_old', 'task_child', 'task_new')
         ORDER BY task_id ASC, depends_on_task_id ASC`,
			)
			.all() as { task_id: string; depends_on_task_id: string }[];
		db.close();

		expect(oldTask).toEqual({
			status: "failed",
			attempts: 1,
			fencing_token: 1,
			result_json: '{"reason":"bad intermediate output"}',
		});
		expect(newTask).toEqual({
			status: "queued",
			attempts: 0,
			fencing_token: 0,
			result_json: "{}",
			payload_json: '{"copied":true}',
			max_attempts: 7,
			created_by_run_id: "run_actor",
			completed_at: null,
		});
		expect(cancelledEvents.count).toBe(0);
		expect(dependencyRows).toEqual([
			{ task_id: "task_child", depends_on_task_id: "task_new" },
			{ task_id: "task_new", depends_on_task_id: "task_upstream" },
		]);
	});
});
