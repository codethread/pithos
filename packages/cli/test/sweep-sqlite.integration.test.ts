/**
 * Integration tests for pithos sweepCommand — real SQLite.
 * CLI process smoke tests live in test/sweep-cli.integration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { sweepCommand } from "../src/commands/sweep.ts";
import { enqueueCommand } from "../src/commands/enqueue.ts";
import { runRegisterCommand } from "../src/commands/run.ts";
import { claimCommand } from "../src/commands/claim.ts";
import { initCommand } from "../src/commands/init.ts";
import { makeDbServiceLive } from "../src/layers/db.ts";
import { makeIdServiceTest } from "../src/layers/ids.ts";
import { FsServiceLive } from "../src/layers/fs.ts";
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts";

const silentOutput = makeOutputServiceSilent();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pithos-sweep-"));
}

// ---------------------------------------------------------------------------
// Integration — real SQLite
// ---------------------------------------------------------------------------

describe("sweepCommand (integration — real SQLite)", () => {
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

	/** Enqueue a task. Returns task id. */
	const enqueue = async (taskId: string, capability = "triage"): Promise<string> => {
		const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([taskId]), FsServiceLive, silentOutput);
		await Effect.runPromise(
			Effect.provide(
				enqueueCommand({ scope: "global", capability, title: `Task ${taskId}` }),
				layer,
			),
		);
		return taskId;
	};

	/** Register a run. Returns run id. */
	const registerRun = async (runId: string): Promise<string> => {
		const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([runId]), FsServiceLive, silentOutput);
		await Effect.runPromise(
			Effect.provide(runRegisterCommand({ agentKind: "envy", run: runId }), layer),
		);
		return runId;
	};

	/** Claim a task for a run. Returns fencing token. */
	const claim = async (runId: string, leaseMinutes = 10): Promise<number> => {
		const out = makeOutputServiceTest();
		const layer = Layer.mergeAll(dbLayer, out.layer);
		await Effect.runPromise(
			Effect.provide(
				claimCommand({ run: runId, scope: "global", capability: "triage", leaseMinutes }),
				layer,
			),
		);
		const parsed = JSON.parse(out.lines()[0]!) as { task: { fencing_token: number } };
		return parsed.task.fencing_token;
	};

	/** Force a task's lease to be expired in the past by direct SQL update. */
	const expireLease = (taskId: string, secondsAgo = 60): void => {
		const db = new Database(dbPath);
		db.prepare(
			`UPDATE tasks
       SET lease_until = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-' || ? || ' seconds'))
       WHERE id = ?`,
		).run(secondsAgo, taskId);
		db.close();
	};

	/** Force a run's last_heartbeat_at to be old by direct SQL update. */
	const expireHeartbeat = (runId: string, minutesAgo = 20): void => {
		const db = new Database(dbPath);
		db.prepare(
			`UPDATE runs
       SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-' || ? || ' minutes'))
       WHERE id = ?`,
		).run(minutesAgo, runId);
		db.close();
	};

	// -------------------------------------------------------------------------
	// Task requeue path
	// -------------------------------------------------------------------------

	it("requeues an expired claimed task when attempts < max_attempts", async () => {
		await enqueue("task_req1");
		await registerRun("run_req1");
		await claim("run_req1");
		expireLease("task_req1");

		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, silentOutput)));

		const db = new Database(dbPath);
		const row = db
			.prepare("SELECT status, lease_owner_run_id, lease_until FROM tasks WHERE id = 'task_req1'")
			.get() as { status: string; lease_owner_run_id: string | null; lease_until: string | null };
		db.close();

		expect(row.status).toBe("queued");
		expect(row.lease_owner_run_id).toBeNull();
		expect(row.lease_until).toBeNull();
	});

	it("appends task.requeued event on requeue", async () => {
		await enqueue("task_req_ev");
		await registerRun("run_req_ev");
		await claim("run_req_ev");
		expireLease("task_req_ev");

		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, silentOutput)));

		const db = new Database(dbPath);
		const event = db
			.prepare(
				"SELECT type, payload_json FROM events WHERE type = 'task.requeued' AND task_id = 'task_req_ev'",
			)
			.get() as { type: string; payload_json: string } | undefined;
		db.close();

		expect(event).toBeDefined();
		expect(event!.type).toBe("task.requeued");
		const payload = JSON.parse(event!.payload_json) as {
			previous_run_id: string;
			attempts: number;
			max_attempts: number;
		};
		expect(payload.previous_run_id).toBe("run_req_ev");
		expect(payload.attempts).toBe(1);
		expect(payload.max_attempts).toBe(3);
	});

	it("requeues an expired running task (status=running)", async () => {
		await enqueue("task_running1");
		await registerRun("run_running1");
		await claim("run_running1");

		// Force to running status manually
		const db = new Database(dbPath);
		db.prepare("UPDATE tasks SET status = 'running' WHERE id = 'task_running1'").run();
		db.close();

		expireLease("task_running1");

		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, silentOutput)));

		const db2 = new Database(dbPath);
		const row = db2.prepare("SELECT status FROM tasks WHERE id = 'task_running1'").get() as {
			status: string;
		};
		db2.close();

		expect(row.status).toBe("queued");
	});

	// -------------------------------------------------------------------------
	// Dead-letter path
	// -------------------------------------------------------------------------

	it("dead-letters an expired task when attempts >= max_attempts", async () => {
		await enqueue("task_dl1");
		await registerRun("run_dl1");

		// Set max_attempts = 1 so one claim exhausts the budget.
		const db = new Database(dbPath);
		db.prepare("UPDATE tasks SET max_attempts = 1 WHERE id = 'task_dl1'").run();
		db.close();

		await claim("run_dl1");
		expireLease("task_dl1");

		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, silentOutput)));

		const db2 = new Database(dbPath);
		const row = db2.prepare("SELECT status FROM tasks WHERE id = 'task_dl1'").get() as {
			status: string;
		};
		db2.close();

		expect(row.status).toBe("dead_letter");
	});

	it("appends task.dead_lettered event on dead-letter", async () => {
		await enqueue("task_dl_ev");
		await registerRun("run_dl_ev");

		const db = new Database(dbPath);
		db.prepare("UPDATE tasks SET max_attempts = 1 WHERE id = 'task_dl_ev'").run();
		db.close();

		await claim("run_dl_ev");
		expireLease("task_dl_ev");

		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, silentOutput)));

		const db2 = new Database(dbPath);
		const event = db2
			.prepare(
				"SELECT type, payload_json FROM events WHERE type = 'task.dead_lettered' AND task_id = 'task_dl_ev'",
			)
			.get() as { type: string; payload_json: string } | undefined;
		db2.close();

		expect(event).toBeDefined();
		expect(event!.type).toBe("task.dead_lettered");
		const payload = JSON.parse(event!.payload_json) as {
			attempts: number;
			max_attempts: number;
		};
		expect(payload.attempts).toBe(1);
		expect(payload.max_attempts).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Stale run path
	// -------------------------------------------------------------------------

	it("marks a run stale when heartbeat is older than run-stale-minutes", async () => {
		await registerRun("run_stale1");
		expireHeartbeat("run_stale1", 20);

		await Effect.runPromise(
			Effect.provide(sweepCommand({ runStaleMinutes: 15 }), Layer.merge(dbLayer, silentOutput)),
		);

		const db = new Database(dbPath);
		const row = db.prepare("SELECT status FROM runs WHERE id = 'run_stale1'").get() as {
			status: string;
		};
		db.close();

		expect(row.status).toBe("stale");
	});

	it("does not mark a run stale when heartbeat is within the threshold", async () => {
		await registerRun("run_fresh1");
		// Only 5 minutes old — threshold is 15 minutes.
		expireHeartbeat("run_fresh1", 5);

		await Effect.runPromise(
			Effect.provide(sweepCommand({ runStaleMinutes: 15 }), Layer.merge(dbLayer, silentOutput)),
		);

		const db = new Database(dbPath);
		const row = db.prepare("SELECT status FROM runs WHERE id = 'run_fresh1'").get() as {
			status: string;
		};
		db.close();

		expect(row.status).not.toBe("stale");
	});

	it("marks a run stale when created_at is old and no heartbeat was recorded", async () => {
		await registerRun("run_no_hb");

		// Back-date created_at and leave last_heartbeat_at NULL.
		const db = new Database(dbPath);
		db.prepare(
			`UPDATE runs
       SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-20 minutes'))
       WHERE id = 'run_no_hb'`,
		).run();
		db.close();

		await Effect.runPromise(
			Effect.provide(sweepCommand({ runStaleMinutes: 15 }), Layer.merge(dbLayer, silentOutput)),
		);

		const db2 = new Database(dbPath);
		const row = db2.prepare("SELECT status FROM runs WHERE id = 'run_no_hb'").get() as {
			status: string;
		};
		db2.close();

		expect(row.status).toBe("stale");
	});

	it("does not affect already-ended runs", async () => {
		await registerRun("run_ended1");
		const db = new Database(dbPath);
		db.prepare(
			`UPDATE runs SET status = 'ended', last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-60 minutes'))
       WHERE id = 'run_ended1'`,
		).run();
		db.close();

		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, silentOutput)));

		const db2 = new Database(dbPath);
		const row = db2.prepare("SELECT status FROM runs WHERE id = 'run_ended1'").get() as {
			status: string;
		};
		db2.close();

		expect(row.status).toBe("ended");
	});

	// -------------------------------------------------------------------------
	// Output and idempotency
	// -------------------------------------------------------------------------

	it("outputs JSON with ok:true and zero counts when nothing to sweep", async () => {
		const out = makeOutputServiceTest();
		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, out.layer)));

		expect(out.lines()).toHaveLength(1);
		const parsed = JSON.parse(out.lines()[0]!) as {
			ok: boolean;
			requeued: number;
			dead_lettered: number;
			stale_runs: number;
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.requeued).toBe(0);
		expect(parsed.dead_lettered).toBe(0);
		expect(parsed.stale_runs).toBe(0);
	});

	it("outputs correct counts when tasks are requeued and dead-lettered", async () => {
		// One task to requeue (max_attempts=3, attempts will be 1).
		await enqueue("task_count_req");
		await registerRun("run_count_req");
		await claim("run_count_req");
		expireLease("task_count_req");

		// One task to dead-letter (max_attempts=1).
		await enqueue("task_count_dl");
		await registerRun("run_count_dl");
		const db = new Database(dbPath);
		db.prepare("UPDATE tasks SET max_attempts = 1 WHERE id = 'task_count_dl'").run();
		db.close();
		await claim("run_count_dl");
		expireLease("task_count_dl");

		const out = makeOutputServiceTest();
		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, out.layer)));

		const parsed = JSON.parse(out.lines()[0]!) as {
			ok: boolean;
			requeued: number;
			dead_lettered: number;
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.requeued).toBe(1);
		expect(parsed.dead_lettered).toBe(1);
	});

	it("is idempotent — second sweep on clean DB returns zeros", async () => {
		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, silentOutput)));

		const out = makeOutputServiceTest();
		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, out.layer)));

		const parsed = JSON.parse(out.lines()[0]!) as {
			ok: boolean;
			requeued: number;
			dead_lettered: number;
			stale_runs: number;
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.requeued).toBe(0);
		expect(parsed.dead_lettered).toBe(0);
		expect(parsed.stale_runs).toBe(0);
	});

	it("does not requeue tasks whose lease_until is in the future", async () => {
		await enqueue("task_future");
		await registerRun("run_future");
		// Claim with a long lease — default 10 minutes, definitely not expired.
		await claim("run_future", 10);

		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, silentOutput)));

		const db = new Database(dbPath);
		const row = db.prepare("SELECT status FROM tasks WHERE id = 'task_future'").get() as {
			status: string;
		};
		db.close();

		expect(row.status).toBe("claimed");
	});

	it("does not touch queued tasks (no lease)", async () => {
		await enqueue("task_queued1");

		await Effect.runPromise(Effect.provide(sweepCommand(), Layer.merge(dbLayer, silentOutput)));

		const db = new Database(dbPath);
		const row = db.prepare("SELECT status FROM tasks WHERE id = 'task_queued1'").get() as {
			status: string;
		};
		db.close();

		expect(row.status).toBe("queued");
	});

	// -------------------------------------------------------------------------
	// Grace period
	// -------------------------------------------------------------------------

	it("respects --lease-grace-seconds: does not requeue when within grace period", async () => {
		await enqueue("task_grace1");
		await registerRun("run_grace1");
		await claim("run_grace1");
		// Expire the lease by 5 seconds.
		expireLease("task_grace1", 5);

		// Sweep with a 30-second grace — the 5-second expiry is within grace.
		await Effect.runPromise(
			Effect.provide(sweepCommand({ leaseGraceSeconds: 30 }), Layer.merge(dbLayer, silentOutput)),
		);

		const db = new Database(dbPath);
		const row = db.prepare("SELECT status FROM tasks WHERE id = 'task_grace1'").get() as {
			status: string;
		};
		db.close();

		expect(row.status).toBe("claimed");
	});

	it("requeues when expiry is past the grace period", async () => {
		await enqueue("task_grace2");
		await registerRun("run_grace2");
		await claim("run_grace2");
		// Expire the lease by 60 seconds — well past any grace window.
		expireLease("task_grace2", 60);

		await Effect.runPromise(
			Effect.provide(sweepCommand({ leaseGraceSeconds: 10 }), Layer.merge(dbLayer, silentOutput)),
		);

		const db = new Database(dbPath);
		const row = db.prepare("SELECT status FROM tasks WHERE id = 'task_grace2'").get() as {
			status: string;
		};
		db.close();

		expect(row.status).toBe("queued");
	});
});
