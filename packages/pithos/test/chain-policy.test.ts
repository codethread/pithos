import { describe, expect, it } from "vitest";
import { PithosError } from "../src/errors.js";
import {
	assertDependencyAcyclic,
	finalDependencyIds,
	graphClosure,
	resolveChainPolicy,
	unresolvedDependencyIds,
	upstreamDependencyLineage,
	type ChainGraphInput,
	type ChainTask,
} from "../src/chain-policy.js";

const task = (
	id: string,
	capability: ChainTask["capability"],
	status: ChainTask["status"] = "queued",
): ChainTask => ({
	id,
	capability,
	status,
});

const ordinary = task("held", "design", "claimed");
const escalation = task("esc", "escalate", "claimed");

const expectValidationError = (f: () => unknown, message: string): void => {
	try {
		f();
	} catch (error) {
		expect(error).toBeInstanceOf(PithosError);
		expect(error).toMatchObject({ code: "VALIDATION_ERROR", message });
		return;
	}
	throw new Error("expected validation error");
};

const graph: ChainGraphInput = {
	tasks: [
		task("root", "triage", "done"),
		task("source", "design", "failed"),
		task("esc", "escalate", "queued"),
		task("child", "execute", "queued"),
		task("new", "execute", "queued"),
		task("old", "execute", "cancelled"),
	],
	dependencies: [
		{ taskId: "child", dependsOnTaskId: "root" },
		{ taskId: "new", dependsOnTaskId: "child" },
	],
	sources: [{ taskId: "esc", sourceTaskId: "source" }],
	supersessions: [{ oldTaskId: "old", newTaskId: "new" }],
};

describe("chain policy resolver", () => {
	it("keeps no-held auto intentionally flat", () => {
		expect(
			resolveChainPolicy({
				policy: "auto",
				newTaskCapability: "execute",
				heldTask: null,
				heldSourceTaskId: null,
			}),
		).toMatchObject({
			applied: "flat_no_held_task",
			implicitDependencyIds: [],
			sourceTaskId: null,
		});
	});

	it("depends on ordinary held work for ordinary auto follow-up", () => {
		expect(
			resolveChainPolicy({
				policy: "auto",
				newTaskCapability: "execute",
				heldTask: ordinary,
				heldSourceTaskId: null,
			}),
		).toMatchObject({
			applied: "depends_on_held",
			implicitDependencyIds: ["held"],
			sourceTaskId: null,
		});
	});

	it("source-links escalation from ordinary held work without blocking it", () => {
		expect(
			resolveChainPolicy({
				policy: "auto",
				newTaskCapability: "escalate",
				heldTask: ordinary,
				heldSourceTaskId: null,
			}),
		).toMatchObject({
			applied: "source_from_held",
			implicitDependencyIds: [],
			sourceTaskId: "held",
		});
	});

	it("routes ordinary auto follow-up from held escalation to its source", () => {
		expect(
			resolveChainPolicy({
				policy: "auto",
				newTaskCapability: "triage",
				heldTask: escalation,
				heldSourceTaskId: "source",
			}),
		).toMatchObject({
			applied: "depends_on_source",
			implicitDependencyIds: ["source"],
			sourceTaskId: "source",
		});
	});

	it("no-ops visibly for held escalation without source", () => {
		expect(
			resolveChainPolicy({
				policy: "auto",
				newTaskCapability: "execute",
				heldTask: escalation,
				heldSourceTaskId: null,
			}),
		).toMatchObject({
			applied: "flat_held_escalation_without_source",
			implicitDependencyIds: [],
		});
	});

	it("no-ops for escalation from held escalation", () => {
		expect(
			resolveChainPolicy({
				policy: "auto",
				newTaskCapability: "escalate",
				heldTask: escalation,
				heldSourceTaskId: "source",
			}),
		).toMatchObject({
			applied: "flat_escalation_from_escalation",
			implicitDependencyIds: [],
		});
	});

	it("none never adds implicit dependency or source", () => {
		expect(
			resolveChainPolicy({
				policy: "none",
				newTaskCapability: "escalate",
				heldTask: ordinary,
				heldSourceTaskId: "source",
			}),
		).toMatchObject({
			applied: "none_selected",
			implicitDependencyIds: [],
			sourceTaskId: null,
		});
	});

	it("held succeeds only with a held ordinary follow-up", () => {
		expect(
			resolveChainPolicy({
				policy: "held",
				newTaskCapability: "execute",
				heldTask: ordinary,
				heldSourceTaskId: null,
			}).implicitDependencyIds,
		).toEqual(["held"]);
		expectValidationError(
			() =>
				resolveChainPolicy({
					policy: "held",
					newTaskCapability: "execute",
					heldTask: null,
					heldSourceTaskId: null,
				}),
			"--chain held requires a held task",
		);
		expectValidationError(
			() =>
				resolveChainPolicy({
					policy: "held",
					newTaskCapability: "escalate",
					heldTask: ordinary,
					heldSourceTaskId: null,
				}),
			"--chain held cannot be used when enqueueing escalation tasks",
		);
	});

	it("source succeeds only with held source and non-escalate follow-up", () => {
		expect(
			resolveChainPolicy({
				policy: "source",
				newTaskCapability: "triage",
				heldTask: escalation,
				heldSourceTaskId: "source",
			}).implicitDependencyIds,
		).toEqual(["source"]);
		expectValidationError(
			() =>
				resolveChainPolicy({
					policy: "source",
					newTaskCapability: "execute",
					heldTask: null,
					heldSourceTaskId: "source",
				}),
			"--chain source requires a held task",
		);
		expectValidationError(
			() =>
				resolveChainPolicy({
					policy: "source",
					newTaskCapability: "execute",
					heldTask: escalation,
					heldSourceTaskId: null,
				}),
			"--chain source requires the held task to have a source link",
		);
		expectValidationError(
			() =>
				resolveChainPolicy({
					policy: "source",
					newTaskCapability: "escalate",
					heldTask: escalation,
					heldSourceTaskId: "source",
				}),
			"--chain source cannot be used when enqueueing escalation tasks",
		);
	});
});

describe("pure chain graph helpers", () => {
	it("combines manual and implicit dependencies for fan-in", () => {
		expect(
			finalDependencyIds({ manualDependencyIds: ["manual"], implicitDependencyIds: ["held"] }),
		).toEqual(["manual", "held"]);
	});

	it("rejects duplicate final dependencies", () => {
		expect.hasAssertions();
		expectValidationError(
			() => finalDependencyIds({ manualDependencyIds: ["held"], implicitDependencyIds: ["held"] }),
			"duplicate dependency task id: held",
		);
	});

	it("keeps source links out of dependency lineage and unresolved blockers", () => {
		expect(upstreamDependencyLineage(graph, "esc")).toEqual([]);
		expect(upstreamDependencyLineage(graph, "new")).toEqual(["child", "root"]);
		expect(unresolvedDependencyIds(graph, "esc")).toEqual([]);
		expect(unresolvedDependencyIds(graph, "new")).toEqual(["child"]);
	});

	it("closes graphs over source-linked nodes and supersession neighbors", () => {
		expect(graphClosure(graph, ["esc"])).toEqual(["esc", "source"]);
		expect(graphClosure(graph, ["old"])).toEqual(["child", "new", "old", "root"]);
	});

	it("rejects dependency cycles but ignores source-only cycles for dependency acyclicity", () => {
		expectValidationError(
			() =>
				assertDependencyAcyclic([
					{ taskId: "a", dependsOnTaskId: "b" },
					{ taskId: "b", dependsOnTaskId: "a" },
				]),
			"task dependency cycle detected",
		);
		const sourceCycleGraph: ChainGraphInput = {
			tasks: [task("a", "triage"), task("b", "execute")],
			dependencies: [],
			sources: [
				{ taskId: "a", sourceTaskId: "b" },
				{ taskId: "b", sourceTaskId: "a" },
			],
			supersessions: [],
		};
		expect(() => assertDependencyAcyclic(sourceCycleGraph.dependencies)).not.toThrow();
		expect(graphClosure(sourceCycleGraph, ["a"])).toEqual(["a", "b"]);
	});

	it("fails loudly when graph helpers receive unknown edge endpoints", () => {
		expect.hasAssertions();
		expectValidationError(
			() =>
				graphClosure({ ...graph, sources: [{ taskId: "esc", sourceTaskId: "missing" }] }, ["esc"]),
			"source edge references unknown task: missing",
		);
	});
});
