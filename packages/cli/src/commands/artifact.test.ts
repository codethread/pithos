/**
 * Unit tests for pithos artifact. Integration coverage lives in test/artifact-*.integration.test.ts.
 */

import { describe, it, expect } from "vitest";
import { Effect, Exit, Layer } from "effect";

import { artifactAddCommand } from "./artifact.ts";
import { makeDbServiceTest } from "../layers/db.ts";
import { makeIdServiceTest } from "../layers/ids.ts";
import { makeFsServiceTest } from "../layers/fs.ts";
import { makeOutputServiceSilent } from "../layers/output.ts";

const silentOutput = makeOutputServiceSilent();

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
	return Effect.runPromiseExit(effect);
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / validation only
// ---------------------------------------------------------------------------

describe("artifactAddCommand (unit — fake DB)", () => {
	const fakeLayer = Layer.mergeAll(
		makeDbServiceTest(),
		makeIdServiceTest([]),
		makeFsServiceTest(),
		silentOutput,
	);

	it("fails VALIDATION_ERROR when --task is missing", async () => {
		const exit = await runEff(
			Effect.provide(
				artifactAddCommand({
					task: undefined,
					run: "run_abc",
					kind: "worker-completion",
					title: "Report",
					bodyFile: undefined,
				}),
				fakeLayer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --run is missing", async () => {
		const exit = await runEff(
			Effect.provide(
				artifactAddCommand({
					task: "task_abc",
					run: undefined,
					kind: "worker-completion",
					title: "Report",
					bodyFile: undefined,
				}),
				fakeLayer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --kind is missing", async () => {
		const exit = await runEff(
			Effect.provide(
				artifactAddCommand({
					task: "task_abc",
					run: "run_abc",
					kind: undefined,
					title: "Report",
					bodyFile: undefined,
				}),
				fakeLayer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when --title is missing", async () => {
		const exit = await runEff(
			Effect.provide(
				artifactAddCommand({
					task: "task_abc",
					run: "run_abc",
					kind: "worker-completion",
					title: undefined,
					bodyFile: undefined,
				}),
				fakeLayer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails NOT_FOUND when --body-file does not exist", async () => {
		const layer = Layer.mergeAll(
			makeDbServiceTest(),
			makeIdServiceTest([]),
			makeFsServiceTest(),
			silentOutput,
		);
		const exit = await runEff(
			Effect.provide(
				artifactAddCommand({
					task: "task_abc",
					run: "run_abc",
					kind: "worker-completion",
					title: "Report",
					bodyFile: "/nonexistent/report.md",
				}),
				layer,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});
});
