import { describe, expect, it } from "vitest";
import { findDependencyCycle } from "./task-graph.ts";

describe("findDependencyCycle", () => {
	it("returns null for an acyclic graph", () => {
		const cycle = findDependencyCycle([
			{ taskId: "task_b", dependsOnTaskId: "task_a" },
			{ taskId: "task_c", dependsOnTaskId: "task_b" },
		]);

		expect(cycle).toBeNull();
	});

	it("returns a deterministic cycle path when a cycle exists", () => {
		const cycle = findDependencyCycle([
			{ taskId: "task_c", dependsOnTaskId: "task_a" },
			{ taskId: "task_a", dependsOnTaskId: "task_b" },
			{ taskId: "task_b", dependsOnTaskId: "task_c" },
		]);

		expect(cycle).toEqual(["task_a", "task_b", "task_c", "task_a"]);
	});
});
