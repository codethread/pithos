/**
 * Unit tests for pithos briefingCommand.
 * Integration coverage lives in test/briefing-sqlite.integration.test.ts and
 * test/briefing-cli.integration.test.ts.
 */

import { describe, it, expect } from "vitest";
import { Effect, Exit, Layer } from "effect";

import { briefingCommand, BRIEFING_SQL } from "./briefing.ts";
import { LOAD_UNRESOLVED_DEPENDENCIES_SQL } from "../domain/task-graph.ts";
import { makeDbServiceTest } from "../layers/db.ts";
import type { DbRow } from "../services/db.ts";
import { makeOutputServiceSilent, makeOutputServiceTest } from "../layers/output.ts";

const silentOutput = makeOutputServiceSilent();

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
	return Effect.runPromiseExit(effect);
}

// ---------------------------------------------------------------------------
// Fixtures — minimal row shapes that satisfy each Schema.Class decoder.
// Fields not listed in overrides use safe MVP defaults.
// ---------------------------------------------------------------------------

function makeTaskRow(overrides: {
	id: string;
	status: string;
	title?: string;
	scope_id?: string;
	capability?: string;
	attempts?: number;
	max_attempts?: number;
	lease_owner_run_id?: string | null;
	lease_until?: string | null;
	created_at?: string;
}): DbRow {
	return {
		id: overrides.id,
		scope_id: overrides.scope_id ?? "global",
		capability: overrides.capability ?? "triage",
		status: overrides.status,
		title: overrides.title ?? `Task ${overrides.id}`,
		body: "",
		payload_json: "{}",
		lease_owner_run_id: overrides.lease_owner_run_id ?? null,
		lease_until: overrides.lease_until ?? null,
		fencing_token: 1,
		attempts: overrides.attempts ?? 1,
		max_attempts: overrides.max_attempts ?? 3,
		result_json: "{}",
		created_by_run_id: null,
		created_at: overrides.created_at ?? "2026-05-01T12:00:00Z",
		updated_at: "2026-05-01T12:00:00Z",
		completed_at: null,
	};
}

function makeRunRow(overrides: {
	id: string;
	status?: string;
	agent_kind?: string;
	last_heartbeat_at?: string | null;
}): DbRow {
	return {
		id: overrides.id,
		agent_kind: overrides.agent_kind ?? "envy",
		scope_id: null,
		task_id: null,
		parent_run_id: null,
		harness: "claude-code",
		session_id: null,
		tmux_target: null,
		cwd: null,
		status: overrides.status ?? "stale",
		last_heartbeat_at: overrides.last_heartbeat_at ?? "2026-05-01T11:00:00Z",
		last_hook: null,
		last_summary: null,
		metadata_json: "{}",
		created_at: "2026-05-01T10:00:00Z",
		updated_at: "2026-05-01T11:00:00Z",
		ended_at: null,
	};
}

function makeArtifactRow(overrides: {
	id: string;
	kind: string;
	title: string;
	task_id?: string | null;
	run_id?: string | null;
}): DbRow {
	return {
		id: overrides.id,
		task_id: overrides.task_id ?? null,
		run_id: overrides.run_id ?? null,
		kind: overrides.kind,
		title: overrides.title,
		body: "artifact body",
		metadata_json: "{}",
		created_at: "2026-05-01T12:30:00Z",
	};
}

// ---------------------------------------------------------------------------
// Unit tests — fake DB / validation only
// ---------------------------------------------------------------------------

describe("briefingCommand (unit — fake DB)", () => {
	it("succeeds on empty DB and renders all four sections", async () => {
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(), out.layer);
		const exit = await runEff(Effect.provide(briefingCommand(), layer));
		expect(Exit.isSuccess(exit)).toBe(true);
		const text = out.lines().join("\n");
		expect(text).toContain("## Pandora briefing");
		expect(text).toContain("### Needs Adam");
		expect(text).toContain("### Ready for review");
		expect(text).toContain("### Active");
		expect(text).toContain("#### Ready queued");
		expect(text).toContain("#### Blocked queued");
		expect(text).toContain("#### Claimed / running");
		expect(text).toContain("### Stale / failed");
	});

	it("includes as_of_event_id: 0 when no events", async () => {
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("as_of_event_id: 0");
	});

	it("shows correct watermark from seeded max event id", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, [{ max_id: 42 }]],
			[BRIEFING_SQL.TASKS, []],
			[BRIEFING_SQL.STALE_RUNS, []],
			[BRIEFING_SQL.ARTIFACTS, []],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("as_of_event_id: 42");
	});

	it("shows _nothing_ placeholder in all sections on empty DB", async () => {
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		// Four sections each with _nothing_
		expect((text.match(/_nothing_/g) ?? []).length).toBeGreaterThanOrEqual(4);
	});

	it("places done task in Ready for review section", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, []],
			[
				BRIEFING_SQL.TASKS,
				[makeTaskRow({ id: "task_done_1", status: "done", title: "Done task" })],
			],
			[BRIEFING_SQL.STALE_RUNS, []],
			[BRIEFING_SQL.ARTIFACTS, []],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("[done] `task_done_1`");
		expect(text).toContain("Done task");
	});

	it("includes worker-completion artifact summary under done task (watermark test)", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, [{ max_id: 10 }]],
			[
				BRIEFING_SQL.TASKS,
				[makeTaskRow({ id: "task_done_2", status: "done", title: "Done with artifact" })],
			],
			[BRIEFING_SQL.STALE_RUNS, []],
			[
				BRIEFING_SQL.ARTIFACTS,
				[
					makeArtifactRow({
						id: "artifact_1",
						kind: "worker-completion",
						title: "Worker report",
						task_id: "task_done_2",
					}),
				],
			],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		// Watermark is present
		expect(text).toContain("as_of_event_id: 10");
		// Done task header present
		expect(text).toContain("[done] `task_done_2`");
		// Artifact summary indented under done task
		expect(text).toContain("worker-completion");
		expect(text).toContain("Worker report");
	});

	it("places dead_letter task in Needs Adam section", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, []],
			[
				BRIEFING_SQL.TASKS,
				[
					makeTaskRow({
						id: "task_dl_1",
						status: "dead_letter",
						title: "Dead task",
						attempts: 3,
						max_attempts: 3,
					}),
				],
			],
			[BRIEFING_SQL.STALE_RUNS, []],
			[BRIEFING_SQL.ARTIFACTS, []],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("[dead_letter]");
		expect(text).toContain("task_dl_1");
		expect(text).toContain("Dead task");
	});

	it("places claimed and running tasks in Active section", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, []],
			[
				BRIEFING_SQL.TASKS,
				[
					makeTaskRow({ id: "task_claimed_1", status: "claimed", title: "Claimed task" }),
					makeTaskRow({ id: "task_running_1", status: "running", title: "Running task" }),
				],
			],
			[BRIEFING_SQL.STALE_RUNS, []],
			[BRIEFING_SQL.ARTIFACTS, []],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("[claimed]");
		expect(text).toContain("task_claimed_1");
		expect(text).toContain("[running]");
		expect(text).toContain("task_running_1");
	});

	it("places ready queued tasks under the Ready queued subsection", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, []],
			[
				BRIEFING_SQL.TASKS,
				[makeTaskRow({ id: "task_q_1", status: "queued", title: "Queued task" })],
			],
			[BRIEFING_SQL.STALE_RUNS, []],
			[BRIEFING_SQL.ARTIFACTS, []],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("#### Ready queued");
		expect(text).toContain("[queued]");
		expect(text).toContain("task_q_1");
	});

	it("renders blocked queued tasks with blocker scope and status", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, []],
			[
				BRIEFING_SQL.TASKS,
				[makeTaskRow({ id: "task_blocked", status: "queued", title: "Blocked task" })],
			],
			[
				LOAD_UNRESOLVED_DEPENDENCIES_SQL,
				[
					{
						id: "task_dep_1",
						scope_id: "repo:api",
						status: "running",
						title: "API blocker",
						created_at: "2026-05-01T12:00:00Z",
					},
				],
			],
			[BRIEFING_SQL.STALE_RUNS, []],
			[BRIEFING_SQL.ARTIFACTS, []],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("#### Blocked queued");
		expect(text).toContain("[queued blocked] `task_blocked`");
		expect(text).toContain("blocked by `task_dep_1` (scope: repo:api, status: running)");
	});

	it("places stale runs in Stale / failed section", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, []],
			[BRIEFING_SQL.TASKS, []],
			[BRIEFING_SQL.STALE_RUNS, [makeRunRow({ id: "run_stale_1", agent_kind: "envy" })]],
			[BRIEFING_SQL.ARTIFACTS, []],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("[stale run]");
		expect(text).toContain("run_stale_1");
		expect(text).toContain("envy");
	});

	it("places failed tasks in Stale / failed section", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, []],
			[
				BRIEFING_SQL.TASKS,
				[makeTaskRow({ id: "task_failed_1", status: "failed", title: "Failed task" })],
			],
			[BRIEFING_SQL.STALE_RUNS, []],
			[BRIEFING_SQL.ARTIFACTS, []],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("[failed]");
		expect(text).toContain("task_failed_1");
	});

	it("places question artifacts in Needs Adam section", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, []],
			[BRIEFING_SQL.TASKS, []],
			[BRIEFING_SQL.STALE_RUNS, []],
			[
				BRIEFING_SQL.ARTIFACTS,
				[
					makeArtifactRow({
						id: "artifact_q",
						kind: "question",
						title: "Can you clarify?",
						task_id: "task_abc",
					}),
				],
			],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("[question]");
		expect(text).toContain("Can you clarify?");
	});

	it("design-brief artifact appears under done task in Ready for review", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, []],
			[
				BRIEFING_SQL.TASKS,
				[makeTaskRow({ id: "task_design", status: "done", title: "Design task" })],
			],
			[BRIEFING_SQL.STALE_RUNS, []],
			[
				BRIEFING_SQL.ARTIFACTS,
				[
					makeArtifactRow({
						id: "artifact_design",
						kind: "design-brief",
						title: "Design doc",
						task_id: "task_design",
					}),
				],
			],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("design-brief");
		expect(text).toContain("Design doc");
	});

	it("claimed task includes run reference in Active line", async () => {
		const seedRows = new Map<string, readonly DbRow[]>([
			[BRIEFING_SQL.WATERMARK, []],
			[
				BRIEFING_SQL.TASKS,
				[
					makeTaskRow({
						id: "task_ref_1",
						status: "claimed",
						lease_owner_run_id: "run_abc",
						title: "Ref task",
					}),
				],
			],
			[BRIEFING_SQL.STALE_RUNS, []],
			[BRIEFING_SQL.ARTIFACTS, []],
		]);
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(seedRows), out.layer);
		await runEff(Effect.provide(briefingCommand(), layer));
		const text = out.lines().join("\n");
		expect(text).toContain("run_abc");
	});

	it("fails with VALIDATION_ERROR for invalid --agent value", async () => {
		const layer = Layer.merge(makeDbServiceTest(), silentOutput);
		const exit = await runEff(Effect.provide(briefingCommand({ agent: "unknown-agent" }), layer));
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("succeeds without --agent (defaults to pandora)", async () => {
		const out = makeOutputServiceTest();
		const layer = Layer.merge(makeDbServiceTest(), out.layer);
		const exit = await runEff(Effect.provide(briefingCommand(), layer));
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(out.lines().join("\n")).toContain("## Pandora briefing");
	});
});
