/**
 * Unit tests for `pithos init` — fake DbService only.
 * Integration coverage lives in test/init.integration.test.ts.
 */

import { describe, it, expect } from "vitest";
import { Effect, Exit, Layer } from "effect";

import { initCommand } from "./init.ts";
import { runMigrations } from "../db/migrate.ts";
import { makeDbServiceTest } from "../layers/db.ts";
import { makeOutputServiceSilent } from "../layers/output.ts";

const silentOutput = makeOutputServiceSilent();

describe("initCommand (unit — fake DB)", () => {
	it("succeeds with a fresh fake DB", async () => {
		const exit = await Effect.runPromiseExit(
			Effect.provide(initCommand, Layer.merge(makeDbServiceTest(), silentOutput)),
		);
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("succeeds a second time (idempotent with fake DB)", async () => {
		const layer = Layer.merge(makeDbServiceTest(), silentOutput);
		const first = await Effect.runPromiseExit(Effect.provide(initCommand, layer));
		const second = await Effect.runPromiseExit(Effect.provide(initCommand, layer));
		expect(Exit.isSuccess(first)).toBe(true);
		expect(Exit.isSuccess(second)).toBe(true);
	});
});

describe("runMigrations (unit — fake DB)", () => {
	it("applies migrations when schema_migrations returns no rows", async () => {
		const exit = await Effect.runPromiseExit(Effect.provide(runMigrations, makeDbServiceTest()));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("skips already-recorded migrations", async () => {
		const seeded = new Map([["SELECT version FROM schema_migrations", [{ version: 1 }]]]);
		const exit = await Effect.runPromiseExit(
			Effect.provide(runMigrations, makeDbServiceTest(seeded)),
		);
		expect(Exit.isSuccess(exit)).toBe(true);
	});
});
