import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { cancelCommand } from "../src/commands/cancel.ts";
import { enqueueCommand } from "../src/commands/enqueue.ts";
import { initCommand } from "../src/commands/init.ts";
import { runRegisterCommand } from "../src/commands/run.ts";
import { makeDbServiceLive } from "../src/layers/db.ts";
import { FsServiceLive } from "../src/layers/fs.ts";
import { makeIdServiceTest } from "../src/layers/ids.ts";
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts";

const silentOutput = makeOutputServiceSilent();

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pithos-cancel-"));
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
	return Effect.runPromiseExit(effect);
}

describe("cancelCommand (integration — real SQLite)", () => {
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

	const enqueue = async (taskId: string): Promise<void> => {
		await Effect.runPromise(
			Effect.provide(
				enqueueCommand({
					scope: "global",
					capability: "triage",
					title: `Task ${taskId}`,
				}),
				makeLayer([taskId]),
			),
		);
	};

	it("cancels queued work transactionally and emits task.cancelled", async () => {
		await registerRun("run_actor");
		await enqueue("task_cancel_me");

		const out = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(
				cancelCommand({
					taskId: "task_cancel_me",
					run: "run_actor",
					reason: "No longer needed",
				}),
				Layer.merge(dbLayer, out.layer),
			),
		);

		expect(JSON.parse(out.lines()[0]!)).toEqual({
			ok: true,
			task: {
				id: "task_cancel_me",
				status: "cancelled",
				scope_id: "global",
				capability: "triage",
			},
		});

		const db = new Database(dbPath);
		const task = db.prepare(`SELECT status FROM tasks WHERE id = 'task_cancel_me'`).get() as {
			status: string;
		};
		const event = db
			.prepare(
				`SELECT task_id, actor_run_id, type, payload_json
         FROM events
         WHERE task_id = 'task_cancel_me'
           AND type = 'task.cancelled'`,
			)
			.get() as {
			task_id: string;
			actor_run_id: string;
			type: string;
			payload_json: string;
		};
		db.close();

		expect(task.status).toBe("cancelled");
		expect(event).toMatchObject({
			task_id: "task_cancel_me",
			actor_run_id: "run_actor",
			type: "task.cancelled",
		});
		expect(JSON.parse(event.payload_json)).toEqual({ reason: "No longer needed" });
	});

	it("allows failed and dead_letter tasks and rejects claimed, running, done, and cancelled tasks", async () => {
		await registerRun("run_actor");
		await enqueue("task_failed");
		await enqueue("task_dead_letter");
		await enqueue("task_claimed");
		await enqueue("task_running");
		await enqueue("task_done");
		await enqueue("task_cancelled");

		const db = new Database(dbPath);
		db.prepare(`UPDATE tasks SET status = 'failed' WHERE id = 'task_failed'`).run();
		db.prepare(`UPDATE tasks SET status = 'dead_letter' WHERE id = 'task_dead_letter'`).run();
		db.prepare(`UPDATE tasks SET status = 'claimed' WHERE id = 'task_claimed'`).run();
		db.prepare(`UPDATE tasks SET status = 'running' WHERE id = 'task_running'`).run();
		db.prepare(`UPDATE tasks SET status = 'done' WHERE id = 'task_done'`).run();
		db.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = 'task_cancelled'`).run();
		db.close();

		await Effect.runPromise(
			Effect.provide(
				cancelCommand({ taskId: "task_failed", run: "run_actor", reason: "abandon failed" }),
				Layer.merge(dbLayer, silentOutput),
			),
		);
		await Effect.runPromise(
			Effect.provide(
				cancelCommand({
					taskId: "task_dead_letter",
					run: "run_actor",
					reason: "abandon dead letter",
				}),
				Layer.merge(dbLayer, silentOutput),
			),
		);

		for (const [taskId, status] of [
			["task_claimed", "claimed"],
			["task_running", "running"],
			["task_done", "done"],
			["task_cancelled", "cancelled"],
		] as const) {
			const exit = await runEff(
				Effect.provide(
					cancelCommand({ taskId, run: "run_actor", reason: "not allowed" }),
					Layer.merge(dbLayer, silentOutput),
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			const cause = Exit.isFailure(exit) ? String(exit.cause) : "";
			expect(cause).toContain(`Cannot cancel task ${taskId} while it is ${status}`);
		}
	});
});
