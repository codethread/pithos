/**
 * Integration tests for pithos tailCommand — real SQLite.
 * Unit coverage lives in src/commands/tail.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { tailCommand } from "../src/commands/tail.ts";
import { enqueueCommand } from "../src/commands/enqueue.ts";
import { runRegisterCommand } from "../src/commands/run.ts";
import { supersedeCommand } from "../src/commands/supersede.ts";
import { initCommand } from "../src/commands/init.ts";
import { makeDbServiceLive } from "../src/layers/db.ts";
import { makeIdServiceTest } from "../src/layers/ids.ts";
import { FsServiceLive } from "../src/layers/fs.ts";
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts";

const silentOutput = makeOutputServiceSilent();

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pithos-tail-"));
}

describe("tailCommand (integration — real SQLite)", () => {
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

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	const enqueue = async (
		taskId: string,
		opts: {
			capability?: string;
			title?: string;
			dependsOn?: readonly string[];
			run?: string;
		} = {},
	): Promise<void> => {
		const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([taskId]), FsServiceLive, silentOutput);
		await Effect.runPromise(
			Effect.provide(
				enqueueCommand({
					scope: "global",
					capability: opts.capability ?? "triage",
					title: opts.title ?? `Task ${taskId}`,
					dependsOn: opts.dependsOn,
					run: opts.run,
				}),
				layer,
			),
		);
	};

	const registerRun = async (runId: string): Promise<void> => {
		const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([runId]), FsServiceLive, silentOutput);
		await Effect.runPromise(
			Effect.provide(runRegisterCommand({ agentKind: "envy", run: runId }), layer),
		);
	};

	const supersede = async (
		taskId: string,
		replacementTaskId: string,
		opts: {
			run: string;
			reason: string;
			title?: string;
		},
	): Promise<void> => {
		const layer = Layer.mergeAll(
			dbLayer,
			makeIdServiceTest([replacementTaskId]),
			FsServiceLive,
			silentOutput,
		);
		await Effect.runPromise(
			Effect.provide(
				supersedeCommand({
					taskId,
					run: opts.run,
					reason: opts.reason,
					title: opts.title,
				}),
				layer,
			),
		);
	};

	const setTaskStatus = (taskId: string, status: string): void => {
		const db = new Database(dbPath);
		db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, taskId);
		db.close();
	};

	// ---------------------------------------------------------------------------
	// Tests
	// ---------------------------------------------------------------------------

	it("returns ok:true with empty events on fresh DB after init", async () => {
		const out = makeOutputServiceTest();
		await Effect.runPromise(Effect.provide(tailCommand(), Layer.merge(dbLayer, out.layer)));
		const parsed = JSON.parse(out.lines()[0]!) as {
			ok: boolean;
			events: unknown[];
			count: number;
		};
		expect(parsed.ok).toBe(true);
		// pithos init does not emit events; only commands do
		expect(parsed.count).toBe(0);
		expect(parsed.events).toHaveLength(0);
	});

	it("includes task.created event after enqueue", async () => {
		await enqueue("task_tail_1");

		const out = makeOutputServiceTest();
		await Effect.runPromise(Effect.provide(tailCommand(), Layer.merge(dbLayer, out.layer)));
		const parsed = JSON.parse(out.lines()[0]!) as {
			ok: boolean;
			events: { id: number; type: string; task_id: string | null }[];
			count: number;
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.count).toBeGreaterThan(0);

		const types = parsed.events.map((e) => e.type);
		expect(types).toContain("task.created");
	});

	it("includes task_id reference in task events", async () => {
		await enqueue("task_tail_ref");

		const out = makeOutputServiceTest();
		await Effect.runPromise(Effect.provide(tailCommand(), Layer.merge(dbLayer, out.layer)));
		const parsed = JSON.parse(out.lines()[0]!) as {
			events: { type: string; task_id: string | null }[];
		};
		const taskEvent = parsed.events.find((e) => e.type === "task.created");
		expect(taskEvent).toBeDefined();
		expect(taskEvent!.task_id).toBe("task_tail_ref");
	});

	it("surfaces task.created graph payloads for dependency authoring", async () => {
		await registerRun("run_tail_creator");
		await enqueue("task_tail_parent", { title: "Parent task" });
		await enqueue("task_tail_child", {
			capability: "execute",
			title: "Child task",
			dependsOn: ["task_tail_parent"],
			run: "run_tail_creator",
		});

		const out = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(tailCommand({ limit: 10 }), Layer.merge(dbLayer, out.layer)),
		);
		const parsed = JSON.parse(out.lines()[0]!) as {
			events: {
				type: string;
				task_id: string | null;
				actor_run_id: string | null;
				payload_json: string;
			}[];
		};
		const createdEvent = parsed.events.find(
			(event) => event.type === "task.created" && event.task_id === "task_tail_child",
		);
		expect(createdEvent).toBeDefined();
		expect(createdEvent?.actor_run_id).toBe("run_tail_creator");

		const payload = JSON.parse(createdEvent?.payload_json ?? "{}") as {
			scope_id: string;
			capability: string;
			title: string;
			depends_on_task_ids: string[];
			supersedes_task_id?: string;
		};
		expect(payload).toEqual({
			scope_id: "global",
			capability: "execute",
			title: "Child task",
			depends_on_task_ids: ["task_tail_parent"],
		});
		expect("supersedes_task_id" in payload).toBe(false);
	});

	it("includes run_id reference in run.registered events", async () => {
		await registerRun("run_tail_ref");

		const out = makeOutputServiceTest();
		await Effect.runPromise(Effect.provide(tailCommand(), Layer.merge(dbLayer, out.layer)));
		const parsed = JSON.parse(out.lines()[0]!) as {
			events: { type: string; run_id: string | null }[];
		};
		const runEvent = parsed.events.find((e) => e.type === "run.registered");
		expect(runEvent).toBeDefined();
		expect(runEvent!.run_id).toBe("run_tail_ref");
	});

	it("surfaces task supersession and cancellation graph payloads end-to-end", async () => {
		await registerRun("run_tail_actor");
		await enqueue("task_tail_a", { title: "Task A" });
		await enqueue("task_tail_b", {
			capability: "execute",
			title: "Task B",
			dependsOn: ["task_tail_a"],
		});
		await enqueue("task_tail_c", {
			capability: "execute",
			title: "Task C",
			dependsOn: ["task_tail_b"],
		});
		setTaskStatus("task_tail_a", "done");
		await supersede("task_tail_b", "task_tail_d", {
			run: "run_tail_actor",
			reason: "Wrong middle task",
			title: "Task D",
		});

		const out = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(tailCommand({ limit: 20 }), Layer.merge(dbLayer, out.layer)),
		);
		const parsed = JSON.parse(out.lines()[0]!) as {
			events: {
				type: string;
				task_id: string | null;
				actor_run_id: string | null;
				payload_json: string;
			}[];
		};

		const graphEvents = parsed.events.filter(
			(event) =>
				(event.type === "task.created" && event.task_id === "task_tail_d") ||
				(event.type === "task.cancelled" && event.task_id === "task_tail_b") ||
				(event.type === "task.superseded" && event.task_id === "task_tail_b"),
		);
		const createdEvent = graphEvents.find(
			(event) => event.type === "task.created" && event.task_id === "task_tail_d",
		);
		const cancelledEvent = graphEvents.find(
			(event) => event.type === "task.cancelled" && event.task_id === "task_tail_b",
		);
		const supersededEvent = graphEvents.find(
			(event) => event.type === "task.superseded" && event.task_id === "task_tail_b",
		);

		expect(graphEvents.map((event) => event.type)).toEqual([
			"task.cancelled",
			"task.created",
			"task.superseded",
		]);
		expect(createdEvent).toBeDefined();
		expect(cancelledEvent).toBeDefined();
		expect(supersededEvent).toBeDefined();
		expect(createdEvent?.actor_run_id).toBe("run_tail_actor");
		expect(cancelledEvent?.actor_run_id).toBe("run_tail_actor");
		expect(supersededEvent?.actor_run_id).toBe("run_tail_actor");
		expect(JSON.parse(createdEvent?.payload_json ?? "{}")).toEqual({
			scope_id: "global",
			capability: "execute",
			title: "Task D",
			depends_on_task_ids: ["task_tail_a"],
			supersedes_task_id: "task_tail_b",
		});
		expect(JSON.parse(cancelledEvent?.payload_json ?? "{}")).toEqual({
			reason: "Wrong middle task",
			superseded_by_task_id: "task_tail_d",
		});
		expect(JSON.parse(supersededEvent?.payload_json ?? "{}")).toEqual({
			new_task_id: "task_tail_d",
			reason: "Wrong middle task",
			retargeted_dependent_task_ids: ["task_tail_c"],
		});
	});

	it("events are ordered ascending by id (oldest-first)", async () => {
		await enqueue("task_tail_order_a");
		await enqueue("task_tail_order_b");
		await enqueue("task_tail_order_c");

		const out = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(tailCommand({ limit: 100 }), Layer.merge(dbLayer, out.layer)),
		);
		const parsed = JSON.parse(out.lines()[0]!) as {
			events: { id: number }[];
		};

		const ids = parsed.events.map((e) => e.id);
		expect(ids.length).toBeGreaterThan(1);
		for (let i = 1; i < ids.length; i++) {
			expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
		}
	});

	it("respects --limit and returns only the N most recent events", async () => {
		// Enqueue 5 tasks → 5 task.created events
		for (let i = 1; i <= 5; i++) {
			await enqueue(`task_tail_lim_${i}`);
		}

		const out = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(tailCommand({ limit: 3 }), Layer.merge(dbLayer, out.layer)),
		);
		const parsed = JSON.parse(out.lines()[0]!) as {
			events: { id: number }[];
			count: number;
		};
		expect(parsed.count).toBe(3);
		expect(parsed.events).toHaveLength(3);
	});

	it("limit returns the most recent N events (highest ids)", async () => {
		// Produce 5 events, then tail with limit=2; expect the last 2 by id
		for (let i = 1; i <= 5; i++) {
			await enqueue(`task_tail_recent_${i}`);
		}

		// Get all events first to know the full id range
		const outAll = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(tailCommand({ limit: 100 }), Layer.merge(dbLayer, outAll.layer)),
		);
		const allParsed = JSON.parse(outAll.lines()[0]!) as {
			events: { id: number }[];
		};
		const allIds = allParsed.events.map((e) => e.id);
		const expectedIds = allIds.slice(-2);

		// Now tail with limit=2
		const outLimited = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(tailCommand({ limit: 2 }), Layer.merge(dbLayer, outLimited.layer)),
		);
		const limitedParsed = JSON.parse(outLimited.lines()[0]!) as {
			events: { id: number }[];
		};
		const limitedIds = limitedParsed.events.map((e) => e.id);
		expect(limitedIds).toEqual(expectedIds);
	});

	it("returns all events when total < limit", async () => {
		await enqueue("task_tail_few");

		const out = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(tailCommand({ limit: 100 }), Layer.merge(dbLayer, out.layer)),
		);
		const parsed = JSON.parse(out.lines()[0]!) as {
			events: unknown[];
			count: number;
		};
		expect(parsed.count).toBe(parsed.events.length);
		expect(parsed.count).toBeLessThan(100);
	});

	it("each event includes required fields: id, type, created_at, payload_json, task_id, run_id, actor_run_id", async () => {
		await enqueue("task_tail_fields");

		const out = makeOutputServiceTest();
		await Effect.runPromise(Effect.provide(tailCommand(), Layer.merge(dbLayer, out.layer)));
		const parsed = JSON.parse(out.lines()[0]!) as {
			events: Record<string, unknown>[];
		};

		expect(parsed.events.length).toBeGreaterThan(0);
		for (const event of parsed.events) {
			expect(typeof event.id).toBe("number");
			expect(typeof event.type).toBe("string");
			expect(typeof event.created_at).toBe("string");
			expect(typeof event.payload_json).toBe("string");
			expect("task_id" in event).toBe(true);
			expect("run_id" in event).toBe(true);
			expect("actor_run_id" in event).toBe(true);
		}
	});

	it("count field matches events array length", async () => {
		await enqueue("task_tail_cnt_a");
		await enqueue("task_tail_cnt_b");

		const out = makeOutputServiceTest();
		await Effect.runPromise(Effect.provide(tailCommand(), Layer.merge(dbLayer, out.layer)));
		const parsed = JSON.parse(out.lines()[0]!) as {
			count: number;
			events: unknown[];
		};
		expect(parsed.count).toBe(parsed.events.length);
	});
});
