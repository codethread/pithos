import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SpawnerError } from "./errors.js";
import { LiveSpawnerServices } from "./services.js";
import {
	launchRenderedAgent,
	renderAgent,
	renderSessionTranscript,
	type RenderedAgent,
} from "./spawner.js";

const templateDir = join(dirname(fileURLToPath(import.meta.url)), "../../../templates");
const noopExec = () => ({ status: 0, stdout: "", stderr: "" });

const base = {
	runId: "run_test",
	sessionId: "123e4567-e89b-12d3-a456-426614174000",
	scopeId: "scope_repo",
	cwd: "/tmp/repo",
} as const;

const piBucket = (cwd: string): string => `--${cwd.replace(/^\/+/, "").replace(/[/:\\]/g, "-")}--`;
const claudeSessionPath = (cwd: string, sessionId: string): string =>
	`${homedir()}/.claude/projects/${cwd.replace(/[/:\\]/g, "-")}/${sessionId}.jsonl`;
const piSessionPath = (cwd: string, sessionId: string): string =>
	`${homedir()}/.pi/agent/sessions/${piBucket(cwd)}/${sessionId}.jsonl`;

const pithosHelpTree = {
	tool: "pithos",
	name: "pithos",
	path: "pithos",
	usage: "pithos <command>",
	description:
		"Durable state CLI for tasks, runs, claims, artifacts, events, and graph invariants.",
	subcommands: [
		{
			tool: "pithos",
			name: "init",
			path: "pithos init",
			usage: "init [--fresh]",
			description: "Create the Pithos database schema and seed built-in agent kinds.",
			subcommands: [],
		},
		{
			tool: "pithos",
			name: "scope",
			path: "pithos scope",
			usage: "scope <command>",
			description: "Manage durable Pithos scopes used to partition task queues.",
			subcommands: [
				{
					tool: "pithos",
					name: "list",
					path: "pithos scope list",
					usage: "list [--all]",
					description: "List durable Pithos scopes with task/run counts and archive state.",
					subcommands: [],
				},
				{
					tool: "pithos",
					name: "upsert",
					path: "pithos scope upsert",
					usage: "upsert --kind global | repo | worktree [--path text]",
					description: "Create or update a durable Pithos scope.",
					subcommands: [],
				},
			],
		},
		{
			tool: "pithos",
			name: "run",
			path: "pithos run",
			usage: "run <command>",
			description: "Manage durable Pithos run records for agent invocations.",
			subcommands: [],
		},
		{
			tool: "pithos",
			name: "task",
			path: "pithos task",
			usage: "task <command>",
			description: "Manage durable Pithos tasks, claims, fencing, and supersession.",
			subcommands: [
				{
					tool: "pithos",
					name: "claim",
					path: "pithos task claim",
					usage:
						"claim [--run text] --scope text --capability triage | design | execute | escalate",
					description: "Claim one claimable task for a run and return its fencing token.",
					subcommands: [],
				},
				{
					tool: "pithos",
					name: "artifact",
					path: "pithos task artifact",
					usage: "artifact <command>",
					description: "Attach evidence or output to a Pithos task.",
					subcommands: [
						{
							tool: "pithos",
							name: "add",
							path: "pithos task artifact add",
							usage: "add [--run text] --kind text --title text [--stdin] <task-id>",
							description: "Attach an artifact to a task; body is read from stdin when requested.",
							subcommands: [],
						},
					],
				},
				{
					tool: "pithos",
					name: "complete",
					path: "pithos task complete",
					usage: "complete [--run text] --token integer [--stdin] <task-id>",
					description: "Complete a held task using its current fencing token.",
					subcommands: [],
				},
				{
					tool: "pithos",
					name: "fail",
					path: "pithos task fail",
					usage: "fail [--run text] --token integer --reason text <task-id>",
					description: "Fail a held task using its current fencing token.",
					subcommands: [],
				},
			],
		},
		{
			tool: "pithos",
			name: "graph",
			path: "pithos graph",
			usage: "graph <command>",
			description: "Inspect Pithos task dependency, source-link, and supersession graphs.",
			subcommands: [
				{
					tool: "pithos",
					name: "inspect",
					path: "pithos graph inspect",
					usage: "inspect [--task text] [--scope text] [--all] [--json]",
					description:
						"Render a readable dependency graph; pass --json for structured graph metadata.",
					subcommands: [],
				},
			],
		},
		{
			tool: "pithos",
			name: "events",
			path: "pithos events",
			usage: "events <command>",
			description: "Inspect durable Pithos event history.",
			subcommands: [
				{
					tool: "pithos",
					name: "tail",
					path: "pithos events tail",
					usage: "tail [--limit integer]",
					description: "Print newest durable Pithos events.",
					subcommands: [],
				},
			],
		},
		{
			tool: "pithos",
			name: "briefing",
			path: "pithos briefing",
			usage: "briefing [--agent text] [--json]",
			description:
				"Print a readable ready/blocked briefing; pass --json for structured task arrays.",
			subcommands: [],
		},
	],
} as const;
const pithosHelpJson = JSON.stringify(pithosHelpTree);

const pdxHelpTree = {
	tool: "pdx",
	name: "pdx",
	path: "pdx",
	usage: "pdx",
	description:
		"Local supervisor for Pandora's Box agent runs, processes, tmux sessions, and Pandora.",
	subcommands: [
		{
			tool: "pdx",
			name: "daemon",
			path: "pdx daemon",
			usage: "pdx daemon",
			description: "Daemon supervisor commands.",
			subcommands: [
				{
					tool: "pdx",
					name: "status",
					path: "pdx daemon status",
					usage: "pdx daemon status [--data-dir text]",
					description: "Show daemon state, supervised agents, and queue counts.",
					subcommands: [],
				},
				{
					tool: "pdx",
					name: "logs",
					path: "pdx daemon logs",
					usage: "pdx daemon logs [--data-dir text] [--limit integer] [--since text] [--all]",
					description: "Show pdx daemon supervisor JSONL logs (not agent transcripts).",
					subcommands: [],
				},
			],
		},
		{
			tool: "pdx",
			name: "run",
			path: "pdx run",
			usage: "pdx run",
			description: "Inspect or stop supervised agent runs owned by pdx.",
			subcommands: [
				{
					tool: "pdx",
					name: "transcript",
					path: "pdx run transcript",
					usage: "pdx run transcript [--data-dir text] [--limit integer] <run-id>",
					description: "Render an agent harness transcript for a run.",
					subcommands: [],
				},
				{
					tool: "pdx",
					name: "show",
					path: "pdx run show",
					usage: "pdx run show [--data-dir text] <run-id>",
					description: "Jump the current tmux client to a supervised run session.",
					subcommands: [],
				},
			],
		},
		{
			tool: "pdx",
			name: "task",
			path: "pdx task",
			usage: "pdx task",
			description: "Operate on live supervision for Pithos tasks.",
			subcommands: [
				{
					tool: "pdx",
					name: "show",
					path: "pdx task show",
					usage: "pdx task show [--data-dir text] <task-id>",
					description: "Jump to the live tmux session holding a task, if any.",
					subcommands: [],
				},
			],
		},
	],
} as const;
const pdxHelpJson = JSON.stringify(pdxHelpTree);

const agentsFile = (input: {
	agent: string;
	mode: string;
	harnessKind: "claude" | "pi";
	tools?: readonly string[];
	model?: string;
	harnessMode?: "replace" | "append";
	includes?: readonly string[];
	template?: string;
}): string => {
	const {
		agent,
		mode,
		harnessKind,
		tools,
		model = "model_test",
		harnessMode = "append",
		includes = ["_common.md"],
		template = `${agent}.md`,
	} = input;
	return JSON.stringify({
		agents: [
			{
				agent,
				mode,
				harness: {
					kind: harnessKind,
					model,
					system_prompt_mode: harnessMode,
					...(tools === undefined ? {} : { tools }),
				},
				includes,
				template,
			},
		],
	});
};

const fakeRenderServices = (
	agentsJson: string,
	options: {
		readonly pithosStatus?: number;
		readonly pithosStdout?: string;
		readonly pithosStderr?: string;
		readonly pdxStatus?: number;
		readonly pdxStdout?: string;
		readonly pdxStderr?: string;
	} = {},
) =>
	({
		readText: (path: string) => {
			if (path.endsWith("agents.json")) return agentsJson;
			if (path.endsWith("_common.md")) return "COMMON";
			if (path.endsWith("war.md")) {
				return "{{_common.md}} {{model}} {{tools_csv}} {{claims}} {{enqueues}} {{claim_command}}\n{{command_cards}}";
			}
			if (path.endsWith("pandora.md")) return "{{claim_command}}\n{{command_cards}}";
			return "{{claim_command}}\n{{command_cards}}";
		},
		env: (key: string) => (key === "PDX_DATA_DIR" ? "/tmp/pdx-data" : undefined),
		execFile: (file: string, args: readonly string[]) => {
			if (file === "pithos" && args.length === 1 && args[0] === "--help-json") {
				return {
					status: options.pithosStatus ?? 0,
					stdout: options.pithosStdout ?? pithosHelpJson,
					stderr: options.pithosStderr ?? "",
				};
			}
			if (file === "pdx" && args.length === 1 && args[0] === "--help-json") {
				return {
					status: options.pdxStatus ?? 0,
					stdout: options.pdxStdout ?? pdxHelpJson,
					stderr: options.pdxStderr ?? "",
				};
			}
			return {
				status: 1,
				stdout: "",
				stderr: `unexpected execFile call: ${file} ${args.join(" ")}`,
			};
		},
	}) as const;

const makeLaunchServices = (
	agentsJson: string,
	{
		spawnPid,
		tmuxStatus,
		exitCode = 0,
		panePid,
		onTmuxNewSession,
	}: {
		spawnPid?: number;
		tmuxStatus?: string;
		exitCode?: number;
		panePid?: number;
		onTmuxNewSession?: (args: readonly string[]) => void;
	},
) =>
	({
		...fakeRenderServices(agentsJson),
		spawnProcess: () => (spawnPid === undefined ? {} : { pid: spawnPid }),
		writeTempText: (prefix: string, content: string) => `/tmp/${prefix}-${content.length}.md`,
		execFile: (file: string, args: readonly string[]) => {
			if (file === "tmux") {
				if (args[0] === "new-session") {
					onTmuxNewSession?.(args);
					return { status: exitCode, stdout: "", stderr: exitCode === 0 ? "" : "tmux failed" };
				}
				return { status: 0, stdout: panePid?.toString() ?? "", stderr: "" };
			}
			return { status: 0, stdout: tmuxStatus ?? "", stderr: "" };
		},
	}) as const;

describe("bundled agent templates", () => {
	it("document the stdin payload contract", () => {
		const templateText = readdirSync(templateDir)
			.filter(
				(entry) =>
					entry === "_common.md" || ["pandora.md", "toil.md", "greed.md", "war.md"].includes(entry),
			)
			.map((entry) => readFileSync(join(templateDir, entry), "utf8"))
			.join("\n");

		expect(templateText).not.toContain("--body");
		expect(templateText).not.toContain("--body-file");
		expect(templateText).not.toContain("--result-file");
		expect(templateText).toContain("For any Pithos command using `--stdin`");
		expect(templateText).toContain("<<'EOF'");
		expect(templateText).toContain("Ordinary follow-up work should omit `--chain`");
		expect(templateText).toContain("Use `--chain none` for unrelated work");
		expect(templateText).toContain("Resolving the held escalation's source: omit `--chain`");
		expect(templateText).toContain("pass `--chain none --depends-on task_X`");
		expect(templateText).toContain("`task inspect` renders a Markdown handoff by default");
		expect(templateText).toContain("Use the fencing token returned by claim");
		expect(templateText).toContain(
			"A task chain is the inspectable history the user will review later",
		);
		expect(templateText).toContain(
			"Use Pithos for durable work state and pdx for live run/session transcripts",
		);
		expect(templateText).toContain("Use `$PITHOS_BIN scope list` to discover existing scopes");
		expect(templateText).toContain("Execution work should usually target a worktree scope");
		expect(templateText).toContain("use `pdx run show <run-id>` if you know the run");
		expect(templateText).not.toContain("--depends-on <held-task-id>");
		expect(templateText).not.toContain("Use Pithos task commands for inspect");
		expect(templateText).not.toContain("Complete with `pithos task complete");
	});
});

describe("renderAgent", () => {
	it.each(["pi", "claude"] as const)("renders required shape for %s", (harnessKind) => {
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			fakeRenderServices(
				agentsFile({
					agent: "war",
					mode: "afk",
					harnessKind,
					tools: ["bash", "read"],
				}),
			),
		);
		expect(rendered).toMatchObject({
			agent: "war",
			mode: "afk",
			runId: base.runId,
			sessionId: base.sessionId,
			scopeId: base.scopeId,
			cwd: base.cwd,
			harness: {
				kind: harnessKind,
			},
		});
		expect(rendered.sessionLogPath).toBe(
			harnessKind === "claude"
				? claudeSessionPath(base.cwd, base.sessionId)
				: piSessionPath(base.cwd, base.sessionId),
		);
		expect(rendered.harness.argv).toContain("--model");
		expect(rendered.harness.argv).toContain("model_test");
		expect(rendered.harness.argv.includes("--dangerously-skip-permissions")).toBe(
			harnessKind === "claude",
		);
		expect(rendered.harness.argv).toContain("--tools");
		expect(rendered.harness.argv).toContain("bash,read");
	});

	it.each(["pi", "claude"] as const)(
		"renders a begin nudge for %s HITL sessions",
		(harnessKind) => {
			const rendered = renderAgent(
				{ ...base, agent: "pandora", mode: "hitl" },
				fakeRenderServices(
					agentsFile({
						agent: "pandora",
						mode: "hitl",
						harnessKind,
					}),
				),
			);
			expect(rendered.harness.argv.at(-1)).toBe("begin");
		},
	);

	it("loads manifest and templates from $PDX_DATA_DIR/templates when set", () => {
		const dataDir = "/tmp/pdx-custom";
		const templatesDir = `${dataDir}/templates`;
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			{
				readText: (path: string) => {
					if (path === `${templatesDir}/agents.json`) {
						return agentsFile({
							agent: "war",
							mode: "afk",
							harnessKind: "pi",
							tools: ["bash"],
							model: "model_from_data_dir",
						});
					}
					if (path === `${templatesDir}/_common.md`) return "DATA_DIR_COMMON";
					if (path === `${templatesDir}/war.md`) return "{{_common.md}} {{model}} {{tools_csv}}";
					throw new Error(`unexpected readText call: ${path}`);
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: (file: string, args: readonly string[]) => {
					if (file === "pithos" && args.length === 1 && args[0] === "--help-json") {
						return { status: 0, stdout: pithosHelpJson, stderr: "" };
					}
					return { status: 1, stdout: "", stderr: `unexpected execFile call: ${file}` };
				},
			},
		);
		expect(rendered.prompt).toContain("DATA_DIR_COMMON model_from_data_dir bash");
		expect(rendered.harness.argv).toContain("model_from_data_dir");
		expect(rendered.harness.argv).toContain("bash");
	});

	it("renders War prompt with generated Pithos command cards", () => {
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			fakeRenderServices(
				agentsFile({
					agent: "war",
					mode: "afk",
					harnessKind: "pi",
				}),
			),
		);
		expect(rendered.prompt).toContain("pithos task claim");
		expect(rendered.prompt).toContain("pithos task artifact add");
		expect(rendered.prompt).toContain("pithos task complete");
		expect(rendered.prompt).toContain("pithos task fail");
		expect(rendered.prompt).toContain(
			"pithos task claim --run run_test --scope scope_repo --capability execute",
		);
		expect(rendered.prompt).not.toContain("Use Pithos task commands for inspect");
	});

	it("renders scope command cards for routing agents", () => {
		for (const agent of ["toil", "greed"] as const) {
			const rendered = renderAgent(
				{ ...base, agent, mode: "afk" },
				fakeRenderServices(
					agentsFile({
						agent,
						mode: "afk",
						harnessKind: "pi",
					}),
				),
			);
			expect(rendered.prompt).toContain("pithos scope");
			expect(rendered.prompt).toContain("pithos task");
		}
	});

	it("renders Pandora prompt with generated Pithos and pdx command cards", () => {
		const rendered = renderAgent(
			{ ...base, agent: "pandora", mode: "hitl" },
			fakeRenderServices(
				agentsFile({
					agent: "pandora",
					mode: "hitl",
					harnessKind: "pi",
				}),
			),
		);
		expect(rendered.prompt).toContain("pithos scope");
		expect(rendered.prompt).toContain("pithos briefing");
		expect(rendered.prompt).toContain("pithos graph inspect");
		expect(rendered.prompt).toContain("pithos events tail");
		expect(rendered.prompt).not.toContain("pdx daemon status");
		expect(rendered.prompt).not.toContain("pdx daemon logs");
		expect(rendered.prompt).toContain("pdx run transcript");
		expect(rendered.prompt).toContain("pdx run show");
		expect(rendered.prompt).toContain("pdx task show");
	});

	it("fails loudly when configured pdx command cards are missing", () => {
		const missingTranscriptHelp = JSON.stringify({
			...pdxHelpTree,
			subcommands: [pdxHelpTree.subcommands[0]],
		});
		expect(() =>
			renderAgent(
				{ ...base, agent: "pandora", mode: "hitl" },
				fakeRenderServices(
					agentsFile({
						agent: "pandora",
						mode: "hitl",
						harnessKind: "pi",
					}),
					{ pdxStdout: missingTranscriptHelp },
				),
			),
		).toThrow("configured command path missing from generated help tree: pdx run transcript");
	});

	it("fails loudly when Pithos help JSON is malformed", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				fakeRenderServices(
					agentsFile({
						agent: "war",
						mode: "afk",
						harnessKind: "pi",
					}),
					{ pithosStdout: "{" },
				),
			),
		).toThrow("pithos help: command help JSON is malformed");
	});

	it("fails loudly when configured Pithos binary help fails", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				fakeRenderServices(
					agentsFile({
						agent: "war",
						mode: "afk",
						harnessKind: "pi",
					}),
					{ pithosStatus: 127, pithosStderr: "missing pithos" },
				),
			),
		).toThrow("pithos --help-json failed: missing pithos");
	});

	it("validates mode mismatch", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "hitl" },
				fakeRenderServices(
					agentsFile({
						agent: "war",
						mode: "afk",
						harnessKind: "pi",
					}),
				),
			),
		).toThrow(SpawnerError);
	});

	it("validates UUID session ids", () => {
		expect(() =>
			renderAgent(
				{ ...base, sessionId: "not-a-uuid", agent: "war", mode: "afk" },
				fakeRenderServices(
					agentsFile({
						agent: "war",
						mode: "afk",
						harnessKind: "pi",
					}),
				),
			),
		).toThrow("sessionId must be a UUID");
	});

	it("loads relative include and template paths using manifest paths as template variables", () => {
		const dataDir = "/tmp/pdx-custom";
		const templatesDir = `${dataDir}/templates`;
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			{
				readText: (path: string) => {
					if (path === `${templatesDir}/agents.json`) {
						return agentsFile({
							agent: "war",
							mode: "afk",
							harnessKind: "pi",
							includes: [
								"snippets/common.md",
								"../../instruction-files/shared.md",
								"~/agent/common.md",
							],
							template: "/tmp/instruction-files/war.md",
						});
					}
					if (path === `${templatesDir}/snippets/common.md`) return "NESTED_COMMON";
					if (path === "/tmp/instruction-files/shared.md") return "OUTSIDE_COMMON";
					if (path === `${homedir()}/agent/common.md`) return "HOME_COMMON";
					if (path === "/tmp/instruction-files/war.md") {
						return "{{snippets/common.md}} {{../../instruction-files/shared.md}} {{~/agent/common.md}} {{claim_command}}";
					}
					throw new Error(`unexpected readText call: ${path}`);
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: (file: string, args: readonly string[]) => {
					if (file === "pithos" && args.length === 1 && args[0] === "--help-json") {
						return { status: 0, stdout: pithosHelpJson, stderr: "" };
					}
					return { status: 1, stdout: "", stderr: `unexpected execFile call: ${file}` };
				},
			},
		);
		expect(rendered.prompt).toContain("NESTED_COMMON OUTSIDE_COMMON HOME_COMMON");
	});

	it("validates include semantics", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				fakeRenderServices(
					agentsFile({
						agent: "war",
						mode: "afk",
						harnessKind: "pi",
						includes: ["_common.md", "_common.md"],
					}),
				),
			),
		).toThrow("includes must be unique");
	});

	it("requires DB context for preview/manifest render", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				{
					readText: fakeRenderServices(
						agentsFile({
							agent: "war",
							mode: "afk",
							harnessKind: "pi",
						}),
					).readText,
					env: () => undefined,
					execFile: noopExec,
				},
			),
		).toThrow("PITHOS_DB or PDX_DATA_DIR is required for spawner render/preview");
	});
});

describe("launchRenderedAgent", () => {
	it("surfaces AFK spawn precondition failures as tagged launch errors", () => {
		const rendered: RenderedAgent = {
			...base,
			agent: "war",
			mode: "afk",
			logicalName: "pdx--war__scope-repo--123e4567",
			harness: {
				kind: "pi",
				argv: [process.execPath, "--version"],
				env: {},
			},
			sessionLogPath: "/tmp/session.jsonl",
			prompt: "prompt",
			cwd: `/tmp/pdx-spawner-missing-cwd-test-${process.pid.toString()}`,
		};

		let thrown: unknown;
		expect(() => {
			try {
				launchRenderedAgent(rendered, LiveSpawnerServices);
			} catch (error) {
				thrown = error;
				throw error;
			}
		}).toThrow(SpawnerError);
		expect(thrown).toMatchObject({ _tag: "SpawnerError", code: "LAUNCH_ERROR" });
	});

	it("returns runtime metadata without rendered argv/env", () => {
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			fakeRenderServices(
				agentsFile({
					agent: "war",
					mode: "afk",
					harnessKind: "pi",
				}),
			),
		);
		const launched = launchRenderedAgent(rendered, makeLaunchServices("", { spawnPid: 1234 }));
		expect(launched.afk?.pid).toBe(1234);
		expect(launched.sessionLogPath).toBe(rendered.sessionLogPath);
		expect("harnessArgv" in launched).toBe(false);
		expect("harnessEnvKeys" in launched).toBe(false);
	});

	it.each(["pi", "claude"] as const)(
		"launches %s hitl through tmux using a temp prompt file",
		(harnessKind) => {
			const rendered = renderAgent(
				{ ...base, agent: "war", mode: "hitl" },
				fakeRenderServices(
					agentsFile({
						agent: "war",
						mode: "hitl",
						harnessKind,
						harnessMode: "append",
					}),
				),
			);
			let tmuxNewSessionArgs: readonly string[] = [];
			const hitl = launchRenderedAgent(
				rendered,
				makeLaunchServices("", {
					exitCode: 0,
					panePid: 5678,
					tmuxStatus: "ignored",
					onTmuxNewSession: (args) => {
						tmuxNewSessionArgs = args;
					},
				}),
			);
			expect(hitl.hitl).toEqual({ tmuxTarget: "pdx--war__scope-repo--123e4567", panePid: 5678 });
			expect(tmuxNewSessionArgs).toContain("sh");
			expect(tmuxNewSessionArgs).toContain("-c");
			expect(tmuxNewSessionArgs.join("\0")).not.toContain(rendered.prompt);
			expect(tmuxNewSessionArgs.join("\0")).toContain("$(cat '/tmp/pithos-spawner-prompt-");
		},
	);
});

describe("renderSessionTranscript", () => {
	it("parses harness logs from explicit path and defaults limit to 20", () => {
		const sessionLogPath = "session.jsonl";
		const entries = Array.from({ length: 21 }, (_, index) =>
			JSON.stringify({
				type: "user",
				timestamp: `2026-05-10T12:00:${String(index).padStart(2, "0")}Z`,
				message: { content: `Hello ${index}` },
			}),
		);
		const services = {
			readText: () => `${entries.join("\n")}\n`,
			env: () => undefined,
			execFile: noopExec,
		};
		type Result = ReturnType<typeof renderSessionTranscript>;
		const output: Result = renderSessionTranscript(
			{
				harnessKind: "claude",
				sessionLogPath,
			},
			services,
		);
		expect(output.split("\n").filter((line) => line.length > 0)).toHaveLength(20);
		expect(output).toContain("[2026-05-10 12:00:01] USER: Hello 1");
		expect(output).toContain("[2026-05-10 12:00:20] USER: Hello 20");
	});

	it("renders Pi assistant thinking blocks", () => {
		const output = renderSessionTranscript(
			{ harnessKind: "pi", sessionLogPath: "session.jsonl" },
			{
				readText: () =>
					`${JSON.stringify({ type: "message", timestamp: "2026-05-10T12:00:00Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Inspecting design brief" }] } })}\n`,
				env: () => undefined,
				execFile: noopExec,
			},
		);
		expect(output).toContain("[2026-05-10 12:00:00] ASSISTANT: Inspecting design brief");
	});

	it("prefers Pi assistant thinking text over tool fallback", () => {
		const output = renderSessionTranscript(
			{ harnessKind: "pi", sessionLogPath: "session.jsonl" },
			{
				readText: () =>
					`${JSON.stringify({
						type: "message",
						timestamp: "2026-05-10T12:00:00Z",
						message: {
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "Planning transcript fix" },
								{
									type: "toolCall",
									name: "read",
									id: "call_1",
									arguments: { path: "packages/spawner/src/spawner.ts" },
								},
							],
						},
					})}\n`,
				env: () => undefined,
				execFile: noopExec,
			},
		);
		expect(output).toContain("[2026-05-10 12:00:00] ASSISTANT: Planning transcript fix");
		expect(output).not.toContain("[tools: read]");
	});

	it("renders Pi assistant tool fallback when no readable text is present", () => {
		const output = renderSessionTranscript(
			{ harnessKind: "pi", sessionLogPath: "session.jsonl" },
			{
				readText: () =>
					`${JSON.stringify({
						type: "message",
						timestamp: "2026-05-10T12:00:00Z",
						message: {
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "   \n\t" },
								{ type: "toolCall", name: "bash", id: "call_1", arguments: { command: "pwd" } },
							],
						},
					})}\n`,
				env: () => undefined,
				execFile: noopExec,
			},
		);
		expect(output).toContain("[2026-05-10 12:00:00] ASSISTANT: [tools: bash]");
	});

	it("fails loudly on missing or corrupt logs", () => {
		expect(() =>
			renderSessionTranscript(
				{ harnessKind: "pi", sessionLogPath: "missing.jsonl" },
				{
					readText: () => "not-json\n",
					env: () => undefined,
					execFile: noopExec,
				},
			),
		).toThrow(SpawnerError);
	});

	it("fails loudly when included harness message events drift", () => {
		expect(() =>
			renderSessionTranscript(
				{ harnessKind: "pi", sessionLogPath: "session.jsonl" },
				{
					readText: () =>
						`${JSON.stringify({ type: "other", message: "ignored" })}\n${JSON.stringify({ type: "message", timestamp: "2026-05-10T12:00:00Z", message: { role: "user" } })}\n`,
					env: () => undefined,
					execFile: noopExec,
				},
			),
		).toThrow(/required message\.content must be an array/);
	});
});
