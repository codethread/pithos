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
	gates: [],
};

const graphNode = {
	...task,
	claimable: true,
	unresolved_dependency_ids: [] as readonly string[],
	supersedes_task_id: null,
	superseded_by_task_id: null,
};

const graph = (
	nodes: GraphInspectOutput["graph"]["nodes"],
	edges: GraphInspectOutput["graph"]["edges"],
	lateGrowthMarkers: GraphInspectOutput["graph"]["late_growth_markers"] = [],
): GraphInspectOutput => ({
	ok: true,
	graph: { selector: { kind: "all" }, nodes, edges, late_growth_markers: lateGrowthMarkers },
});

describe("engine render helpers", () => {
	it("renders graph dependency trees through the public engine boundary", () => {
		const output = graph(
			[
				{ ...graphNode, id: "task_parent", title: "Parent" },
				{ ...graphNode, id: "task_child", title: "Child" },
			],
			[
				{
					kind: "after",
					from_task_id: "task_child",
					to_task_id: "task_parent",
					satisfied: false,
				},
			],
		);

		expect(renderGraphInspectText(output, { homeDir: "/work" })).toBe(
			"- task_parent [execute] [queued] (~) Parent\n  - task_child [execute] [queued] (~) Child\n",
		);
	});

	it("omits graph scope parentheses for global tasks", () => {
		const output = graph(
			[
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
			[],
		);

		expect(renderGraphInspectText(output, { homeDir: "/work" })).toBe(
			"- task_global [execute] [queued] Global\n",
		);
	});

	it("snapshots typed-edge graph display variations", () => {
		const base = { ...graphNode, scope_description: null };
		const cases: readonly [string, GraphInspectOutput][] = [
			[
				"plain after chain",
				graph(
					[
						{ ...base, id: "task_a", title: "A" },
						{ ...base, id: "task_b", title: "B", unresolved_dependency_ids: ["task_a"] },
					],
					[{ kind: "after", from_task_id: "task_b", to_task_id: "task_a", satisfied: false }],
				),
			],
			[
				"open gate",
				graph(
					[
						{ ...base, id: "task_branch", title: "Branch" },
						{ ...base, id: "task_gate", title: "Checkpoint", capability: "escalate" },
					],
					[
						{
							kind: "gate",
							from_task_id: "task_gate",
							to_task_id: "task_branch",
							state: "open",
							members: [
								{ task_id: "task_branch", canonical_task_id: "task_branch", status: "queued" },
							],
						},
					],
				),
			],
			[
				"clear gate",
				graph(
					[
						{
							...base,
							id: "task_branch",
							title: "Branch",
							status: "done",
							completed_at: "2026-05-08 12:10:00",
						},
						{ ...base, id: "task_gate", title: "Checkpoint", capability: "escalate" },
					],
					[
						{
							kind: "gate",
							from_task_id: "task_gate",
							to_task_id: "task_branch",
							state: "clear",
							members: [
								{ task_id: "task_branch", canonical_task_id: "task_branch", status: "done" },
							],
						},
					],
				),
			],
			[
				"broken gate",
				graph(
					[
						{ ...base, id: "task_branch", title: "Branch", status: "failed" },
						{ ...base, id: "task_gate", title: "Checkpoint", capability: "escalate" },
					],
					[
						{
							kind: "gate",
							from_task_id: "task_gate",
							to_task_id: "task_branch",
							state: "broken",
							members: [
								{ task_id: "task_branch", canonical_task_id: "task_branch", status: "failed" },
							],
						},
					],
				),
			],
			[
				"about escalation",
				graph(
					[
						{ ...base, id: "task_branch", title: "Branch" },
						{
							...base,
							id: "task_about",
							title: "Needs attention",
							capability: "escalate",
							scope_id: "global",
							scope_kind: "global",
							canonical_path: null,
						},
					],
					[{ kind: "about", from_task_id: "task_about", to_task_id: "task_branch" }],
				),
			],
			[
				"repair alert",
				graph(
					[
						{ ...base, id: "task_branch", title: "Branch", status: "failed" },
						{
							...base,
							id: "task_repair",
							title: "Repair",
							capability: "escalate",
							scope_id: "global",
							scope_kind: "global",
							canonical_path: null,
						},
					],
					[{ kind: "repair", from_task_id: "task_repair", to_task_id: "task_branch" }],
				),
			],
			[
				"supersession",
				graph(
					[
						{
							...base,
							id: "task_old",
							title: "Old",
							status: "cancelled",
							superseded_by_task_id: "task_new",
						},
						{ ...base, id: "task_new", title: "New", supersedes_task_id: "task_old" },
					],
					[{ kind: "supersedes", from_task_id: "task_new", to_task_id: "task_old" }],
				),
			],
			[
				"allowed late growth",
				graph(
					[
						{
							...base,
							id: "task_branch",
							title: "Branch",
							status: "done",
							completed_at: "2026-05-08 12:10:00",
						},
						{
							...base,
							id: "task_gate",
							title: "Checkpoint",
							status: "done",
							completed_at: "2026-05-08 12:20:00",
						},
					],
					[
						{
							kind: "gate",
							from_task_id: "task_gate",
							to_task_id: "task_branch",
							state: "clear",
							members: [
								{ task_id: "task_branch", canonical_task_id: "task_branch", status: "done" },
							],
						},
					],
					[
						{
							id: "marker_1",
							gate_task_id: "task_gate",
							gate_target_task_id: "task_branch",
							gate_attempt: 1,
							mutation_kind: "edge_inserted",
							edge_task_id: "task_late",
							edge_target_task_id: "task_branch",
							edge_kind: "after",
							superseded_task_id: null,
							replacement_task_id: null,
							created_by_run_id: "run_war",
							created_at: "2026-05-08 12:30:00",
						},
					],
				),
			],
		];

		expect(
			cases
				.map(
					([name, output]) => `## ${name}\n${renderGraphInspectText(output, { homeDir: "/work" })}`,
				)
				.join("\n"),
		).toMatchSnapshot();
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
			attached_context: [],
			lineage: [],
			supersedes: null,
			superseded_by: null,
			artifacts: [],
			repair_alert_kind: null,
			late_growth_markers: [],
		};

		expect(renderTaskInspectMarkdown(inspect)).toContain(
			"# task_alpha [execute] [queued] Alpha work",
		);
	});
});
