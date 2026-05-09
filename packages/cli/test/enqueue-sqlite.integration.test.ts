import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { enqueueCommand } from "../src/commands/enqueue.ts";
import { initCommand } from "../src/commands/init.ts";
import { runRegisterCommand } from "../src/commands/run.ts";
import { supersedeCommand } from "../src/commands/supersede.ts";
import { makeDbServiceLive } from "../src/layers/db.ts";
import { FsServiceLive } from "../src/layers/fs.ts";
import { makeIdServiceTest } from "../src/layers/ids.ts";
import { makeOutputServiceSilent } from "../src/layers/output.ts";

const silentOutput = makeOutputServiceSilent();

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pithos-enqueue-"));
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
	return Effect.runPromiseExit(effect);
}

describe("enqueueCommand dependency validation (integration — real SQLite)", () => {
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
				enqueueCommand({ scope: "global", capability: "triage", title: `Task ${taskId}` }),
				makeLayer([taskId]),
			),
		);
	};

	it("rejects duplicate dependency IDs before writing", async () => {
		await enqueue("task_dep");

		const exit = await runEff(
			Effect.provide(
				enqueueCommand({
					scope: "global",
					capability: "triage",
					title: "Duplicate dependency task",
					dependsOn: ["task_dep", "task_dep"],
				}),
				makeLayer(["task_new"]),
			),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const cause = Exit.isFailure(exit) ? String(exit.cause) : "";
		expect(cause).toContain("Duplicate --depends-on task IDs: task_dep");

		const db = new Database(dbPath);
		const taskIds = db.prepare(`SELECT id FROM tasks ORDER BY id ASC`).all() as { id: string }[];
		db.close();
		expect(taskIds).toEqual([{ id: "task_dep" }]);
	});

	it("rejects dependencies that have already been superseded", async () => {
		await registerRun("run_actor");
		await enqueue("task_old");
		await Effect.runPromise(
			Effect.provide(
				supersedeCommand({ taskId: "task_old", run: "run_actor", reason: "replace old" }),
				makeLayer(["task_replacement"]),
			),
		);

		const exit = await runEff(
			Effect.provide(
				enqueueCommand({
					scope: "global",
					capability: "triage",
					title: "Depends on old task",
					dependsOn: ["task_old"],
				}),
				makeLayer(["task_new"]),
			),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const cause = Exit.isFailure(exit) ? String(exit.cause) : "";
		expect(cause).toContain("Dependency task task_old has been superseded by task_replacement");
		expect(cause).toContain("Enqueue against the replacement task instead.");

		const db = new Database(dbPath);
		const taskIds = db.prepare(`SELECT id FROM tasks ORDER BY id ASC`).all() as { id: string }[];
		db.close();
		expect(taskIds).toEqual([{ id: "task_old" }, { id: "task_replacement" }]);
	});
});
