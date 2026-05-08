/**
 * Integration tests for pithos runRegisterCommand — real SQLite. Unit coverage lives in src/commands/run.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { runRegisterCommand } from "../src/commands/run.ts";
import { makeDbServiceLive } from "../src/layers/db.ts";
import { makeIdServiceTest, IdServiceLive } from "../src/layers/ids.ts";
import { initCommand } from "../src/commands/init.ts";
import { scopeUpsertCommand } from "../src/commands/scope.ts";
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts";

const silentOutput = makeOutputServiceSilent();

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pithos-run-"));
}

describe("runRegisterCommand (integration — real SQLite)", () => {
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

	it("creates a run with status=starting", async () => {
		const layer = Layer.mergeAll(dbLayer, IdServiceLive, silentOutput);
		await Effect.runPromise(Effect.provide(runRegisterCommand({ agentKind: "envy" }), layer));

		const db = new Database(dbPath);
		const rows = db.prepare("SELECT status FROM runs WHERE agent_kind = 'envy'").all() as {
			status: string;
		}[];
		db.close();

		expect(rows).toHaveLength(1);
		const [firstRow] = rows;
		expect(firstRow?.status).toBe("starting");
	});

	it("generates a run_ prefixed ID", async () => {
		const layer = Layer.mergeAll(dbLayer, IdServiceLive, silentOutput);
		await Effect.runPromise(Effect.provide(runRegisterCommand({ agentKind: "envy" }), layer));

		const db = new Database(dbPath);
		const rows = db.prepare("SELECT id FROM runs").all() as { id: string }[];
		db.close();

		const [rowId] = rows;
		expect(rowId?.id).toMatch(/^run_/);
	});

	it("appends a run.registered lifecycle event", async () => {
		const layer = Layer.mergeAll(dbLayer, IdServiceLive, silentOutput);
		await Effect.runPromise(Effect.provide(runRegisterCommand({ agentKind: "envy" }), layer));

		const db = new Database(dbPath);
		const events = db.prepare("SELECT type FROM events WHERE type = 'run.registered'").all() as {
			type: string;
		}[];
		db.close();

		expect(events).toHaveLength(1);
		const [firstRegEvent] = events;
		expect(firstRegEvent?.type).toBe("run.registered");
	});

	it("stores scope_id and cwd when provided", async () => {
		const scopePath = join(process.env.HOME ?? "/tmp", "work/run-scope-test");
		await Effect.runPromise(
			Effect.provide(
				scopeUpsertCommand({ kind: "repo", path: scopePath }),
				Layer.merge(dbLayer, silentOutput),
			),
		);

		const layer = Layer.mergeAll(dbLayer, IdServiceLive, silentOutput);
		await Effect.runPromise(
			Effect.provide(
				runRegisterCommand({
					agentKind: "envy",
					scopeId: "repo:work/run-scope-test",
					cwd: scopePath,
				}),
				layer,
			),
		);

		const db = new Database(dbPath);
		const row = db.prepare("SELECT scope_id, cwd FROM runs WHERE agent_kind = 'envy'").get() as {
			scope_id: string;
			cwd: string;
		};
		db.close();

		expect(row.scope_id).toBe("repo:work/run-scope-test");
		expect(row.cwd).toBe(scopePath);
	});

	it("is idempotent — re-registering with same run ID returns existing run", async () => {
		const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([]), silentOutput);

		// First call: run_fixed doesn't exist yet, so it inserts
		await Effect.runPromise(
			Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_fixed" }), layer),
		);

		// Second call: run_fixed already exists → returns it unchanged
		await Effect.runPromise(
			Effect.provide(runRegisterCommand({ agentKind: "toil", run: "run_fixed" }), layer),
		);

		const db = new Database(dbPath);
		const rows = db.prepare("SELECT agent_kind FROM runs WHERE id = 'run_fixed'").all() as {
			agent_kind: string;
		}[];
		db.close();

		// Only one row, still the original agent kind
		expect(rows).toHaveLength(1);
		const [fixedRow] = rows;
		expect(fixedRow?.agent_kind).toBe("envy");
	});

	it("outputs JSON with ok:true and run row on success", async () => {
		const out = makeOutputServiceTest();
		await Effect.runPromise(
			Effect.provide(
				runRegisterCommand({ agentKind: "envy", run: "run_json_out" }),
				Layer.mergeAll(dbLayer, makeIdServiceTest([]), out.layer),
			),
		);

		expect(out.lines()).toHaveLength(1);
		const parsed = JSON.parse(out.lines()[0]!) as {
			ok: boolean;
			run: { id: string; agent_kind: string; status: string };
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.run.id).toBe("run_json_out");
		expect(parsed.run.agent_kind).toBe("envy");
		expect(parsed.run.status).toBe("starting");
		expect(out.errorLines()).toHaveLength(0);
	});

	it("idempotent re-registration does not insert a second run.registered event", async () => {
		const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([]), silentOutput);

		await Effect.runPromise(
			Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_idem" }), layer),
		);
		await Effect.runPromise(
			Effect.provide(runRegisterCommand({ agentKind: "envy", run: "run_idem" }), layer),
		);

		const db = new Database(dbPath);
		const events = db.prepare("SELECT type FROM events WHERE type = 'run.registered'").all() as {
			type: string;
		}[];
		db.close();

		expect(events).toHaveLength(1);
	});
});
