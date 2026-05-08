/**
 * Unit tests for pithos complete. Integration coverage lives in test/complete-cli.integration.test.ts and test/complete-sqlite.integration.test.ts.
 */

import { describe, it, expect } from "vitest";
import { Effect, Exit, Layer } from "effect";

import { completeCommand } from "./complete.ts";
import { failCommand } from "./fail.ts";
import { makeDbServiceTest } from "../layers/db.ts";
import { makeFsServiceTest } from "../layers/fs.ts";
import { makeOutputServiceSilent } from "../layers/output.ts";

const silentOutput = makeOutputServiceSilent();

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
	return Effect.runPromiseExit(effect);
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / validation only
// ---------------------------------------------------------------------------

describe("completeCommand (unit — fake DB)", () => {
	const fakeLayer = Layer.mergeAll(makeDbServiceTest(), makeFsServiceTest(), silentOutput);

	it("fails VALIDATION_ERROR when task id is missing", async () => {
		const exit = await runEff(
			Effect.provide(completeCommand({ taskId: undefined, run: "run_abc", token: 1 }), fakeLayer),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --run is missing", async () => {
		const exit = await runEff(
			Effect.provide(completeCommand({ taskId: "task_abc", run: undefined, token: 1 }), fakeLayer),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --token is missing", async () => {
		const exit = await runEff(
			Effect.provide(
				completeCommand({ taskId: "task_abc", run: "run_abc", token: undefined }),
				fakeLayer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --token is NaN", async () => {
		const exit = await runEff(
			Effect.provide(
				completeCommand({ taskId: "task_abc", run: "run_abc", token: NaN }),
				fakeLayer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --result-file is not valid JSON", async () => {
		const fs = makeFsServiceTest(new Map([["/tmp/bad.json", "not json {"]]));
		const layer = Layer.mergeAll(makeDbServiceTest(), fs, silentOutput);
		const exit = await runEff(
			Effect.provide(
				completeCommand({
					taskId: "task_abc",
					run: "run_abc",
					token: 1,
					resultFile: "/tmp/bad.json",
				}),
				layer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});
});

describe("failCommand (unit — fake DB)", () => {
	it("fails VALIDATION_ERROR when task id is missing", async () => {
		const exit = await runEff(
			Effect.provide(
				failCommand({ taskId: undefined, run: "run_abc", token: 1 }),
				Layer.merge(makeDbServiceTest(), silentOutput),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --run is missing", async () => {
		const exit = await runEff(
			Effect.provide(
				failCommand({ taskId: "task_abc", run: undefined, token: 1 }),
				Layer.merge(makeDbServiceTest(), silentOutput),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --token is missing", async () => {
		const exit = await runEff(
			Effect.provide(
				failCommand({ taskId: "task_abc", run: "run_abc", token: undefined }),
				Layer.merge(makeDbServiceTest(), silentOutput),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --token is NaN", async () => {
		const exit = await runEff(
			Effect.provide(
				failCommand({ taskId: "task_abc", run: "run_abc", token: NaN }),
				Layer.merge(makeDbServiceTest(), silentOutput),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});
});
