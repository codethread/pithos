import { describe, expect, it } from "vitest";
import {
	renderBriefingText,
	renderGraphInspectText,
	renderTaskInspectMarkdown,
} from "../src/engine.js";
import type { BriefingOutput, GraphInspectOutput, TaskInspectOutput } from "../src/engine.js";

const task = {
	id: "task_alpha",
	title: "Alpha work",
	capability: "execute" as const,
	status: "queued" as const,
	scope_id: "repo:/work",
	scope_kind: "repo" as const,
	canonical_path: "/work",
	parent_repo_path: null,
	scope_description: "main repo",
	created_at: "2026-05-08 12:00:00",
	completed_at: null,
};

const taskDetail = {
	...task,
	body: "Do the work",
	fencing_token: 1,
	attempts: 0,
	max_attempts: 3,
};

const inspectTask = {
	...taskDetail,
	claimable: true,
	unresolved_dependency_ids: [] as readonly string[],
};

const graphNode = {
	...task,
	claimable: true,
	unresolved_dependency_ids: [] as readonly string[],
	supersedes_task_id: null,
	superseded_by_task_id: null,
	source_task_id: null,
	source_kind: null,
};

describe("engine render helpers", () => {
	it("renders graph dependency trees through the public engine boundary", () => {
		const graph: GraphInspectOutput = {
			ok: true,
			graph: {
				selector: { kind: "all" },
				nodes: [
					{ ...graphNode, id: "task_parent", title: "Parent" },
					{ ...graphNode, id: "task_child", title: "Child" },
				],
				edges: [
					{
						kind: "depends_on",
						from_task_id: "task_child",
						to_task_id: "task_parent",
						satisfied: false,
					},
				],
			},
		};

		expect(renderGraphInspectText(graph, { homeDir: "/work" })).toBe(
			"- task_parent [execute] [queued] (~) Parent\n  - task_child [execute] [queued] (~) Child\n",
		);
	});

	it("omits graph scope parentheses for global tasks", () => {
		const graph: GraphInspectOutput = {
			ok: true,
			graph: {
				selector: { kind: "all" },
				nodes: [
					{
						...graphNode,
						id: "task_global",
						title: "Global",
						scope_id: "global",
						scope_kind: "global",
						canonical_path: null,
						parent_repo_path: null,
						scope_description: null,
					},
				],
				edges: [],
			},
		};

		expect(renderGraphInspectText(graph, { homeDir: "/work" })).toBe(
			"- task_global [execute] [queued] Global\n",
		);
	});

	it("renders briefing sections through the public engine boundary", () => {
		const briefing: BriefingOutput = {
			ok: true,
			ready: [task],
			blocked: [],
			recentlyCompleted: [],
		};

		expect(renderBriefingText(briefing)).toContain(
			"- task_alpha [execute] [queued] Alpha work (main repo)",
		);
	});

	it("renders task inspect markdown through the public engine boundary", () => {
		const inspect: TaskInspectOutput = {
			ok: true,
			task: inspectTask,
			dependencies: [],
			dependents: [],
			source: null,
			lineage: [],
			supersedes: null,
			superseded_by: null,
			artifacts: [],
			repair_alert_kind: null,
		};

		expect(renderTaskInspectMarkdown(inspect)).toContain(
			"# task_alpha [execute] [queued] Alpha work",
		);
	});
});
