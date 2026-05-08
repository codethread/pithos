/**
 * Unit tests for pithos enqueue. Integration coverage lives in test/enqueue-cli.integration.test.ts and test/enqueue-sqlite.integration.test.ts.
 */

import { describe, it, expect } from "vitest";
import { Effect, Exit, Layer } from "effect";

import { enqueueCommand } from "./enqueue.ts";
import { inspectTaskCommand } from "./inspect.ts";
import { makeDbServiceTest } from "../layers/db.ts";
import { makeIdServiceTest } from "../layers/ids.ts";
import { makeFsServiceTest } from "../layers/fs.ts";
import { makeOutputServiceSilent } from "../layers/output.ts";

const silentOutput = makeOutputServiceSilent();

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
	return Effect.runPromiseExit(effect);
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / ID / FS services
// ---------------------------------------------------------------------------

describe("enqueueCommand (unit — fake DB)", () => {
	it("fails VALIDATION_ERROR when --scope is missing", async () => {
		const layer = Layer.mergeAll(
			makeDbServiceTest(),
			makeIdServiceTest([]),
			makeFsServiceTest(),
			silentOutput,
		);
		const exit = await runEff(
			Effect.provide(
				enqueueCommand({ scope: undefined, capability: "watch", title: "Test" }),
				layer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --capability is missing", async () => {
		const layer = Layer.mergeAll(
			makeDbServiceTest(),
			makeIdServiceTest([]),
			makeFsServiceTest(),
			silentOutput,
		);
		const exit = await runEff(
			Effect.provide(
				enqueueCommand({ scope: "global", capability: undefined, title: "Test" }),
				layer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --title is missing", async () => {
		const layer = Layer.mergeAll(
			makeDbServiceTest(),
			makeIdServiceTest([]),
			makeFsServiceTest(),
			silentOutput,
		);
		const exit = await runEff(
			Effect.provide(
				enqueueCommand({ scope: "global", capability: "watch", title: undefined }),
				layer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when duplicate --depends-on IDs are supplied", async () => {
		const layer = Layer.mergeAll(
			makeDbServiceTest(),
			makeIdServiceTest([]),
			makeFsServiceTest(),
			silentOutput,
		);
		const exit = await runEff(
			Effect.provide(
				enqueueCommand({
					scope: "global",
					capability: "watch",
					title: "Test",
					dependsOn: ["task_a", "task_a"],
				}),
				layer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});
});

describe("inspectTaskCommand (unit — fake DB)", () => {
	it("fails NOT_FOUND when task is absent from fake DB", async () => {
		const exit = await runEff(
			Effect.provide(
				inspectTaskCommand("task_missing"),
				Layer.merge(makeDbServiceTest(), silentOutput),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});
});
