import { describe, it, expect } from "vitest";
import { Effect, Exit } from "effect";

import { decodeInspectGraphSelector, filterTerminalChains, renderGraphFlat } from "./inspect.ts";
import type { TaskGraph } from "../domain/task-graph.ts";

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
	return Effect.runPromiseExit(effect);
}

describe("decodeInspectGraphSelector", () => {
	it("fails VALIDATION_ERROR when no selector is provided", async () => {
		const exit = await runEff(
			decodeInspectGraphSelector({
				taskId: undefined,
				scopeId: undefined,
				all: false,
				current: false,
			}),
		);

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails VALIDATION_ERROR when multiple selectors are provided", async () => {
		const exit = await runEff(
			decodeInspectGraphSelector({
				taskId: "task_a",
				scopeId: "scope_a",
				all: false,
				current: false,
			}),
		);

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("returns { kind: 'current' } when --all is provided", async () => {
		const result = await Effect.runPromise(
			decodeInspectGraphSelector({
				taskId: undefined,
				scopeId: undefined,
				all: true,
				current: false,
			}),
		);

		expect(result).toEqual({ kind: "current" });
	});
});

// ---------------------------------------------------------------------------
// renderGraphFlat (pure unit tests)
// ---------------------------------------------------------------------------

const makeNode = (
	id: string,
	title: string,
	status: string,
	supersedes_task_id: string | null = null,
	superseded_by_task_id: string | null = null,
) => ({
	id,
	scope_id: "global",
	capability: "triage",
	status,
	title,
	claimable: false,
	unresolved_dependency_ids: [] as readonly string[],
	supersedes_task_id,
	superseded_by_task_id,
});

describe("renderGraphFlat", () => {
	it("returns empty string for empty graph", () => {
		const graph: TaskGraph = { nodes: [], edges: [] };
		expect(renderGraphFlat(graph)).toBe("");
	});

	it("renders standalone nodes without task IDs", () => {
		const graph: TaskGraph = {
			nodes: [makeNode("task_a", "My task", "queued")],
			edges: [],
		};
		expect(renderGraphFlat(graph)).toBe("[queued] My task");
	});

	it("renders a supersession chain with correct indentation, no task IDs", () => {
		const graph: TaskGraph = {
			nodes: [
				makeNode("task_a", "Original", "cancelled", null, "task_b"),
				makeNode("task_b", "First replacement", "cancelled", "task_a", "task_c"),
				makeNode("task_c", "Latest", "queued", "task_b", null),
			],
			edges: [
				{ kind: "supersedes", from_task_id: "task_b", to_task_id: "task_a" },
				{ kind: "supersedes", from_task_id: "task_c", to_task_id: "task_b" },
			],
		};
		expect(renderGraphFlat(graph)).toBe(
			"[cancelled] Original\n  [cancelled] First replacement\n    [queued] Latest",
		);
	});

	it("separates chains and standalone nodes with blank lines, no task IDs", () => {
		const graph: TaskGraph = {
			nodes: [
				makeNode("task_standalone", "Dependency-only task", "done"),
				makeNode("task_b", "Chain B root", "cancelled", null, "task_c"),
				makeNode("task_c", "Chain B latest", "queued", "task_b", null),
			],
			edges: [{ kind: "supersedes", from_task_id: "task_c", to_task_id: "task_b" }],
		};
		expect(renderGraphFlat(graph)).toBe(
			"[cancelled] Chain B root\n  [queued] Chain B latest\n\n[done] Dependency-only task",
		);
	});
});

// ---------------------------------------------------------------------------
// filterTerminalChains (pure unit tests)
// ---------------------------------------------------------------------------

describe("filterTerminalChains", () => {
	it("returns same graph when there are no terminal chains or standalone nodes", () => {
		const graph: TaskGraph = {
			nodes: [
				makeNode("task_a", "Original", "cancelled", null, "task_b"),
				makeNode("task_b", "Latest", "queued", "task_a", null),
			],
			edges: [{ kind: "supersedes", from_task_id: "task_b", to_task_id: "task_a" }],
		};
		const result = filterTerminalChains(graph);
		expect(result.nodes).toEqual(graph.nodes);
		expect(result.edges).toEqual(graph.edges);
	});

	it("removes a fully-terminal supersession chain (all done/cancelled)", () => {
		const graph: TaskGraph = {
			nodes: [
				makeNode("task_a", "Original", "cancelled", null, "task_b"),
				makeNode("task_b", "Replacement", "done", "task_a", null),
			],
			edges: [{ kind: "supersedes", from_task_id: "task_b", to_task_id: "task_a" }],
		};
		const result = filterTerminalChains(graph);
		expect(result.nodes).toEqual([]);
		expect(result.edges).toEqual([]);
	});

	it("keeps a partially-terminal supersession chain (some nodes still active)", () => {
		const graph: TaskGraph = {
			nodes: [
				makeNode("task_a", "Original", "cancelled", null, "task_b"),
				makeNode("task_b", "Middle", "done", "task_a", "task_c"),
				makeNode("task_c", "Latest", "queued", "task_b", null),
			],
			edges: [
				{ kind: "supersedes", from_task_id: "task_b", to_task_id: "task_a" },
				{ kind: "supersedes", from_task_id: "task_c", to_task_id: "task_b" },
			],
		};
		const result = filterTerminalChains(graph);
		// chain still active at leaf → keep the whole chain
		expect(result.nodes).toEqual(graph.nodes);
		expect(result.edges).toEqual(graph.edges);
	});

	it("removes standalone done nodes", () => {
		const graph: TaskGraph = {
			nodes: [makeNode("task_a", "Done task", "done")],
			edges: [],
		};
		const result = filterTerminalChains(graph);
		expect(result.nodes).toEqual([]);
	});

	it("removes standalone cancelled nodes", () => {
		const graph: TaskGraph = {
			nodes: [makeNode("task_a", "Cancelled task", "cancelled")],
			edges: [],
		};
		const result = filterTerminalChains(graph);
		expect(result.nodes).toEqual([]);
	});

	it("keeps standalone queued nodes", () => {
		const graph: TaskGraph = {
			nodes: [makeNode("task_a", "Active task", "queued")],
			edges: [],
		};
		const result = filterTerminalChains(graph);
		expect(result.nodes).toEqual(graph.nodes);
	});

	it("filters edges referencing removed nodes", () => {
		const graph: TaskGraph = {
			nodes: [
				makeNode("task_a", "Original", "cancelled", null, "task_b"),
				makeNode("task_b", "Replacement", "done", "task_a", null),
				makeNode("task_c", "Active dep", "queued"),
			],
			edges: [
				{ kind: "supersedes", from_task_id: "task_b", to_task_id: "task_a" },
				{ kind: "depends_on", from_task_id: "task_c", to_task_id: "task_b", satisfied: true },
			],
		};
		const result = filterTerminalChains(graph);
		// chain task_a→task_b fully terminal, removed; task_c is standalone queued, kept
		expect(result.nodes).toHaveLength(1);
		expect(result.nodes[0]!.id).toBe("task_c");
		// both edges reference removed nodes → filtered out
		expect(result.edges).toEqual([]);
	});

	it("returns same graph for empty input", () => {
		const graph: TaskGraph = { nodes: [], edges: [] };
		const result = filterTerminalChains(graph);
		expect(result.nodes).toEqual([]);
		expect(result.edges).toEqual([]);
	});
});
