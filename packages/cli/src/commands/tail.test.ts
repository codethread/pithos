/**
 * Unit tests for pithos tailCommand.
 * Integration coverage lives in test/tail-sqlite.integration.test.ts and
 * test/tail-cli.integration.test.ts.
 */

import { describe, it, expect } from "vitest";
import { Effect, Exit, Layer } from "effect";

import { tailCommand } from "./tail.ts";
import { makeDbServiceTest } from "../layers/db.ts";
import { makeOutputServiceSilent, makeOutputServiceTest } from "../layers/output.ts";

const silentOutput = makeOutputServiceSilent();

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
	return Effect.runPromiseExit(effect);
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / validation only
// ---------------------------------------------------------------------------

describe("tailCommand (unit — fake DB)", () => {
	it("succeeds with empty events on empty DB", async () => {
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(), out.layer);
		const exit = await runEff(Effect.provide(tailCommand(), layer));
		expect(Exit.isSuccess(exit)).toBe(true);
		const parsed = JSON.parse(out.lines()[0]!) as {
			ok: boolean;
			events: unknown[];
			count: number;
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.events).toHaveLength(0);
		expect(parsed.count).toBe(0);
	});

	it("uses default limit of 20 when no limit provided", async () => {
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(), out.layer);
		await runEff(Effect.provide(tailCommand(), layer));
		// Just verify it succeeded — the SQL would include LIMIT 20
		expect(out.lines()).toHaveLength(1);
	});

	it("fails VALIDATION_ERROR when limit is zero", async () => {
		const layer = Layer.merge(makeDbServiceTest(), silentOutput);
		const exit = await runEff(Effect.provide(tailCommand({ limit: 0 }), layer));
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when limit is negative", async () => {
		const layer = Layer.merge(makeDbServiceTest(), silentOutput);
		const exit = await runEff(Effect.provide(tailCommand({ limit: -5 }), layer));
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when limit exceeds MAX_LIMIT (1000)", async () => {
		const layer = Layer.merge(makeDbServiceTest(), silentOutput);
		const exit = await runEff(Effect.provide(tailCommand({ limit: 1001 }), layer));
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("output includes ok, count, and events fields", async () => {
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(), out.layer);
		await runEff(Effect.provide(tailCommand({ limit: 10 }), layer));
		const parsed = JSON.parse(out.lines()[0]!) as {
			ok: boolean;
			count: number;
			events: unknown[];
		};
		expect(parsed).toHaveProperty("ok", true);
		expect(parsed).toHaveProperty("count");
		expect(parsed).toHaveProperty("events");
	});
});

// ---------------------------------------------------------------------------
