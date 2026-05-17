import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SpawnerError } from "./errors.js";
import { LiveSpawnerServices } from "./services.js";
import {
	launchRenderedAgent,
	loadHooks,
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
					name: "inspect",
					path: "pithos task inspect",
					usage: "inspect [--json] <task-id>",
					description: "Show an agent-readable task handoff.",
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
				{
					tool: "pithos",
					name: "enqueue",
					path: "pithos task enqueue",
					usage:
						"enqueue [--run text] --scope text --capability triage | design | execute | escalate --title text [--stdin] [--chain auto | none]",
					description: "Create a new queued task.",
					subcommands: [],
				},
				{
					tool: "pithos",
					name: "supersede",
					path: "pithos task supersede",
					usage: "supersede --run text --scope text --title text [--stdin] <task-id>",
					description: "Replace a task with corrected work while preserving history.",
					subcommands: [],
				},
				{
					tool: "pithos",
					name: "cancel",
					path: "pithos task cancel",
					usage: "cancel --run text --reason text <task-id>",
					description: "Abandon a non-held task that should not continue.",
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
					usage:
						"inspect [--task text] [--scope text] [--all] [--status text] [--search text] [--since text] [--json]",
					description:
						"Render a readable task graph with dependencies, source links, and supersessions; pass --json for structured metadata.",
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

const commandSection = (prompt: string, commandPath: string): string => {
	const heading = `#### \`${commandPath}\``;
	const start = prompt.indexOf(heading);
	expect(start).toBeGreaterThanOrEqual(0);
	const next = prompt.indexOf("\n#### `", start + heading.length);
	return next === -1 ? prompt.slice(start) : prompt.slice(start, next);
};

const quoteTomlString = (value: string): string => JSON.stringify(value);
const tomlArray = (values: readonly string[]): string =>
	`[${values.map(quoteTomlString).join(", ")}]`;

const agentsFile = (input: {
	agent: string;
	mode: string;
	harnessKind: "claude" | "pi";
	tools?: readonly string[];
	argv?: readonly string[];
	model?: string;
	harnessMode?: "replace" | "append";
	includes?: readonly string[];
	appends?: readonly string[];
	template?: string;
}): string => {
	const defaults = {
		pandora: {
			template: "pandora.md",
			includes: ["_common.md"] as readonly string[],
			appends: [] as readonly string[],
			harnessKind: "pi" as const,
			model: "model_test",
			harnessMode: "replace" as const,
			tools: undefined as readonly string[] | undefined,
			argv: [] as readonly string[],
		},
		toil: {
			template: "toil.md",
			includes: ["_common.md"] as readonly string[],
			appends: [] as readonly string[],
			harnessKind: "pi" as const,
			model: "model_test",
			harnessMode: "append" as const,
			tools: undefined as readonly string[] | undefined,
			argv: [] as readonly string[],
		},
		greed: {
			template: "greed.md",
			includes: ["_common.md"] as readonly string[],
			appends: [] as readonly string[],
			harnessKind: "pi" as const,
			model: "model_test",
			harnessMode: "replace" as const,
			tools: undefined as readonly string[] | undefined,
			argv: [] as readonly string[],
		},
		war: {
			template: "war.md",
			includes: ["_common.md"] as readonly string[],
			appends: [] as readonly string[],
			harnessKind: "pi" as const,
			model: "model_test",
			harnessMode: "append" as const,
			tools: undefined as readonly string[] | undefined,
			argv: [] as readonly string[],
		},
		envy: {
			template: "envy.md",
			includes: ["_common.md"] as readonly string[],
			appends: [] as readonly string[],
			harnessKind: "pi" as const,
			model: "model_test",
			harnessMode: "append" as const,
			tools: undefined as readonly string[] | undefined,
			argv: [] as readonly string[],
		},
	};
	const merged = {
		...defaults[input.agent as keyof typeof defaults],
		harnessKind: input.harnessKind,
		model: input.model ?? "model_test",
		harnessMode: input.harnessMode ?? "append",
		tools: input.tools,
		argv: input.argv ?? [],
		includes: input.includes ?? ["_common.md"],
		appends: input.appends ?? [],
		template: input.template ?? `${input.agent}.md`,
	};
	const all = { ...defaults, [input.agent]: merged };
	return Object.entries(all)
		.flatMap(([agent, config]) => [
			`[agents.${agent}]`,
			`template = ${quoteTomlString(config.template)}`,
			`includes.replace = ${tomlArray(config.includes)}`,
			`appends.replace = ${tomlArray(config.appends)}`,
			"",
			`[agents.${agent}.harness]`,
			`kind = ${quoteTomlString(config.harnessKind)}`,
			`model = ${quoteTomlString(config.model)}`,
			`system_prompt_mode = ${quoteTomlString(config.harnessMode)}`,
			...(config.tools === undefined ? [] : [`tools.replace = ${tomlArray(config.tools)}`]),
			`argv.replace = ${tomlArray(config.argv)}`,
			"",
		])
		.join("\n");
};

const fakeRenderServices = (
	agentsToml: string,
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
			if (path.endsWith("agents.toml")) return agentsToml;
			if (path.endsWith("_common.md")) return "COMMON";
			if (path.endsWith("war.md")) {
				return "{{_common.md}} {{model}} {{tools_csv}} {{claims}} {{enqueues}} {{claim_command}}\n{{command_cards}}";
			}
			if (path.endsWith("pandora.md")) return "{{claim_command}}\n{{command_cards}}";
			return "{{claim_command}}\n{{command_cards}}";
		},
		env: (key: string) => (key === "PDX_DATA_DIR" ? "/tmp/pdx-data" : undefined),
		execFile: (file: string, args: readonly string[]) => {
			const basename = file.split("/").at(-1);
			if (basename === "pithos" && args.length === 1 && args[0] === "--help-json") {
				return {
					status: options.pithosStatus ?? 0,
					stdout: options.pithosStdout ?? pithosHelpJson,
					stderr: options.pithosStderr ?? "",
				};
			}
			if (basename === "pdx" && args.length === 1 && args[0] === "--help-json") {
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
	it.each([
		["pandora", "hitl", false],
		["toil", "afk", false],
		["greed", "hitl", false],
		["war", "afk", true],
		["envy", "afk", false],
	] as const)("render %s bundled template", (agent, mode, expectsCwdGuard) => {
		const rendered = renderAgent(
			{ ...base, agent, mode },
			{
				readText: (path: string) => readFileSync(path, "utf8"),
				env: (key: string) => (key === "PITHOS_DB" ? "/tmp/pithos.sqlite" : undefined),
				execFile: (file: string, args: readonly string[]) => {
					const basename = file.split("/").at(-1);
					if (basename === "pithos" && args.length === 1 && args[0] === "--help-json") {
						return { status: 0, stdout: pithosHelpJson, stderr: "" };
					}
					if (basename === "pdx" && args.length === 1 && args[0] === "--help-json") {
						return { status: 0, stdout: pdxHelpJson, stderr: "" };
					}
					return { status: 1, stdout: "", stderr: `unexpected execFile call: ${file}` };
				},
			},
		);

		expect(rendered.prompt.includes("cwd/scope guard")).toBe(expectsCwdGuard);
		expect(rendered.prompt).not.toContain("Repository default-branch guard");
	});

	it("keeps bundled Pandora sitrep flow aligned with briefing before graph inspect", () => {
		const rendered = renderAgent(
			{ ...base, agent: "pandora", mode: "hitl" },
			{
				readText: (path: string) => readFileSync(path, "utf8"),
				env: (key: string) => (key === "PITHOS_DB" ? "/tmp/pithos.sqlite" : undefined),
				execFile: (file: string, args: readonly string[]) => {
					const basename = file.split("/").at(-1);
					if (basename === "pithos" && args.length === 1 && args[0] === "--help-json") {
						return { status: 0, stdout: pithosHelpJson, stderr: "" };
					}
					if (basename === "pdx" && args.length === 1 && args[0] === "--help-json") {
						return { status: 0, stdout: pdxHelpJson, stderr: "" };
					}
					return { status: 1, stdout: "", stderr: `unexpected execFile call: ${file}` };
				},
			},
		);
		expect(rendered.prompt).toContain(
			"1. `pithos briefing --agent pandora` for claimable/blocked work, user-facing next actions",
		);
		expect(rendered.prompt).toContain(
			"2. `pithos graph inspect --all` for task inventory, dependency shape",
		);
		const briefingSection = commandSection(rendered.prompt, "pithos briefing");
		expect(briefingSection).toContain("agenda-style ready/blocked summaries");
		const graphSection = commandSection(rendered.prompt, "pithos graph inspect");
		expect(graphSection).toContain("inventory, dependency shape, provenance, audit questions");
		expect(graphSection).toContain("`--task`, `--scope`, and `--all` are mutually exclusive");
		expect(graphSection).toContain("`--status` to OR literal task statuses");
		expect(graphSection).toContain("`--search` to AND terms over task title/body only");
		expect(graphSection).toContain("`--since` accepts `today`, `<n>h`, `<n>d`, `YYYY-MM-DD`");
		expect(graphSection).toContain("Filters narrow seed selection before graph closure");
		expect(graphSection).toContain("Readable output is the normal agent surface");
		expect(graphSection).toContain("reverse `repair_source` closure");
	});

	it("document the stdin payload contract", () => {
		const templateText = readdirSync(templateDir)
			.filter(
				(entry) =>
					entry === "_common.md" ||
					["pandora.md", "toil.md", "greed.md", "war.md", "envy.md"].includes(entry),
			)
			.map((entry) => readFileSync(join(templateDir, entry), "utf8"))
			.join("\n");

		expect(templateText).not.toContain("--body");
		expect(templateText).not.toContain("--body-file");
		expect(templateText).not.toContain("--result-file");
		expect(templateText).toContain("For any Pithos command using `--stdin`");
		expect(templateText).toContain("<<'EOF'");
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
		expect(templateText).toContain("Use `pithos scope list` to discover existing scopes");
		expect(templateText).not.toContain("$PITHOS_BIN");
		expect(templateText).not.toContain("$PDX_BIN");
		expect(templateText).toContain(
			"execution tasks must target one of those filesystem-backed scopes",
		);
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
		expect(rendered.harness.env).not.toHaveProperty("PITHOS_BIN");
		expect(rendered.harness.env).not.toHaveProperty("PDX_BIN");
		expect(rendered.harness.env).not.toHaveProperty("PATH");
	});

	it.each(["pi", "claude"] as const)(
		"renders the begin bootstrap arg for %s HITL sessions",
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
			expect(rendered.logicalName).toBe("pdx--pandora");
			expect(rendered.harness.argv.at(-1)).toBe("begin");
		},
	);

	it("strips the home prefix from repo scope session names", () => {
		const cwd = `${homedir()}/dev/pandoras-box`;
		const dataDir = "/tmp/pdx-session-names-repo";
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk", scopeId: `repo:${cwd}`, cwd },
			{
				readText: (path: string) => {
					if (path === `${dataDir}/agents.toml`) {
						return agentsFile({ agent: "war", mode: "afk", harnessKind: "pi" });
					}
					if (path === `${dataDir}/templates/_common.md`) return "COMMON";
					if (path === `${dataDir}/templates/war.md`) {
						return "{{_common.md}} {{claim_command}}\n{{command_cards}}";
					}
					throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
						code: "ENOENT",
					});
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: (file: string, args: readonly string[]) =>
					file.split("/").at(-1) === "pithos" && args[0] === "--help-json"
						? { status: 0, stdout: pithosHelpJson, stderr: "" }
						: { status: 1, stdout: "", stderr: `unexpected execFile call: ${file}` },
			},
		);
		expect(rendered.logicalName).toBe("pdx--war__repo-dev-pandoras-box--123e4567");
	});

	it("keeps worktree scope kind while stripping the home prefix", () => {
		const cwd = `${homedir()}/dev/pandoras-box__fix--session-names`;
		const dataDir = "/tmp/pdx-session-names-worktree";
		const rendered = renderAgent(
			{
				...base,
				agent: "greed",
				mode: "hitl",
				scopeId: `worktree:${cwd}`,
				cwd,
				parentRepoPath: `${homedir()}/dev/pandoras-box`,
			},
			{
				readText: (path: string) => {
					if (path === `${dataDir}/agents.toml`) {
						return agentsFile({ agent: "greed", mode: "hitl", harnessKind: "pi" });
					}
					if (path === `${dataDir}/templates/_common.md`) return "COMMON";
					if (path === `${dataDir}/templates/greed.md`) {
						return "{{_common.md}} {{claim_command}}\n{{command_cards}}";
					}
					throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
						code: "ENOENT",
					});
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: (file: string, args: readonly string[]) =>
					file.split("/").at(-1) === "pithos" && args[0] === "--help-json"
						? { status: 0, stdout: pithosHelpJson, stderr: "" }
						: { status: 1, stdout: "", stderr: `unexpected execFile call: ${file}` },
			},
		);
		expect(rendered.logicalName).toBe(
			"pdx--greed__worktree-dev-pandoras-box-fix-session-names--123e4567",
		);
	});

	it("loads manifest and templates from $PDX_DATA_DIR/templates when set", () => {
		const dataDir = "/tmp/pdx-custom";
		const templatesDir = `${dataDir}/templates`;
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			{
				readText: (path: string) => {
					if (path === `${dataDir}/agents.toml`) {
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
					throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
						code: "ENOENT",
					});
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: (file: string, args: readonly string[]) => {
					if (
						file.split("/").at(-1) === "pithos" &&
						args.length === 1 &&
						args[0] === "--help-json"
					) {
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

	it("renders War prompt with generated Markdown Pithos command reference", () => {
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
		expect(rendered.prompt).toContain("## Generated command reference");
		expect(rendered.prompt).toContain("#### `pithos task claim`");
		expect(rendered.prompt).toContain("#### `pithos task inspect`");
		expect(rendered.prompt).toContain("#### `pithos task artifact add`");
		expect(rendered.prompt).toContain("#### `pithos task complete`");
		expect(rendered.prompt).toContain("#### `pithos task fail`");
		expect(rendered.prompt).toContain("#### `pithos task enqueue`");
		expect(rendered.prompt).toContain("#### `pithos task supersede`");
		expect(rendered.prompt).toContain("#### `pithos task cancel`");
		expect(rendered.prompt).toContain(
			"- Use the rendered claim command above instead of reconstructing it by hand.",
		);
		expect(rendered.prompt).toContain("- Readable Markdown is the normal task context.");
		expect(rendered.prompt).toContain(
			"- Use `--stdin` with a quoted heredoc (`<<'EOF'`) for artifact body content.",
		);
		expect(rendered.prompt).toContain("- Default completion sends no stdin");
		expect(rendered.prompt).toContain("- Include a concise reason plus relevant evidence");
		expect(rendered.prompt).toContain("- Omit `--chain` for ordinary follow-up");
		const inspectSection = commandSection(rendered.prompt, "pithos task inspect");
		expect(inspectSection).toContain("- Readable Markdown is the normal task context.");
		expect(inspectSection).toContain(
			"- Use `--json` only for exact fields, scripting, or lost-token recovery.",
		);
		expect(inspectSection).not.toContain("- Default completion sends no stdin");
		const supersedeSection = commandSection(rendered.prompt, "pithos task supersede");
		expect(supersedeSection).toContain(
			"- Use for graph repair/replacement, not normal successful completion.",
		);
		expect(supersedeSection).not.toContain(
			"- Use to abandon non-held work, not normal successful completion.",
		);
		const cancelSection = commandSection(rendered.prompt, "pithos task cancel");
		expect(cancelSection).toContain(
			"- Use to abandon non-held work, not normal successful completion.",
		);
		expect(rendered.prompt).toContain(
			"```sh\npithos task claim [--run text] --scope text --capability triage | design | execute | escalate\n```",
		);

		expect(rendered.prompt).toContain(
			"pithos task claim --run run_test --scope scope_repo --capability execute",
		);
		expect(rendered.prompt).not.toContain("pithos scope list");
		expect(rendered.prompt).not.toContain("pithos graph inspect");
		expect(rendered.prompt).not.toContain("pithos events tail");
		expect(rendered.prompt).not.toContain("pithos briefing");
		expect(rendered.prompt).not.toContain("### Pithos help JSON");
		expect(rendered.prompt).not.toContain("```json");
		expect(rendered.prompt).not.toContain('"subcommands"');
		expect(rendered.prompt).not.toContain("Use Pithos task commands for inspect");
	});

	it("renders scope command reference for routing agents", () => {
		for (const agent of ["toil", "greed", "envy"] as const) {
			const rendered = renderAgent(
				{ ...base, agent, mode: agent === "greed" ? "hitl" : "afk" },
				fakeRenderServices(
					agentsFile({
						agent,
						mode: "afk",
						harnessKind: "pi",
					}),
				),
			);
			expect(rendered.prompt).toContain("#### `pithos scope list`");
			expect(rendered.prompt).toContain("#### `pithos scope upsert`");
			expect(rendered.prompt).toContain("#### `pithos task claim`");
			expect(rendered.prompt).not.toContain("#### `pithos graph inspect`");
			expect(rendered.prompt).not.toContain("#### `pithos events tail`");
			expect(rendered.prompt).not.toContain("#### `pithos briefing`");
			expect(rendered.prompt).not.toContain("### Pithos help JSON");
			expect(rendered.prompt).not.toContain("```json");
		}
	});

	it("renders Pandora prompt with generated Markdown Pithos and pdx command reference", () => {
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
		expect(rendered.prompt).toContain("### Pithos");
		expect(rendered.prompt).toContain("### pdx inspection");
		expect(rendered.prompt).toContain("#### `pithos scope list`");
		expect(rendered.prompt).toContain("#### `pithos briefing`");
		expect(rendered.prompt).toContain("#### `pithos graph inspect`");
		expect(rendered.prompt).toContain("dependencies, source links, and supersessions");
		expect(rendered.prompt).toContain("#### `pithos events tail`");
		expect(rendered.prompt).not.toContain("pdx daemon status");
		expect(rendered.prompt).not.toContain("pdx daemon logs");
		expect(rendered.prompt).toContain("#### `pdx run transcript`");
		expect(rendered.prompt).toContain("#### `pdx run show`");
		expect(rendered.prompt).toContain("#### `pdx task show`");

		expect(rendered.prompt).not.toContain("### Pithos help JSON");
		expect(rendered.prompt).not.toContain("### pdx inspection help JSON");
		expect(rendered.prompt).not.toContain("```json");
		expect(rendered.prompt).not.toContain('"subcommands"');
	});

	it("fails loudly when command annotations reference unknown help paths", () => {
		const taskWithoutInspect = {
			...pithosHelpTree.subcommands[3],
			subcommands: pithosHelpTree.subcommands[3].subcommands.filter(
				(command) => command.path !== "pithos task inspect",
			),
		};
		const helpWithoutInspect = JSON.stringify({
			...pithosHelpTree,
			subcommands: pithosHelpTree.subcommands.map((command) =>
				command.path === "pithos task" ? taskWithoutInspect : command,
			),
		});
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				fakeRenderServices(
					agentsFile({
						agent: "war",
						mode: "afk",
						harnessKind: "pi",
					}),
					{ pithosStdout: helpWithoutInspect },
				),
			),
		).toThrow("command annotation references unknown generated help path: pithos task inspect");
	});

	it.each([
		{
			name: "Pithos",
			agent: "toil" as const,
			mode: "afk" as const,
			stdout: {
				pithosStdout: JSON.stringify({
					...pithosHelpTree,
					subcommands: pithosHelpTree.subcommands.filter(
						(command) => command.path !== "pithos scope",
					),
				}),
			},
			error: "configured command path missing from generated help tree: pithos scope",
		},
		{
			name: "pdx",
			agent: "pandora" as const,
			mode: "hitl" as const,
			stdout: {
				pdxStdout: JSON.stringify({
					...pdxHelpTree,
					subcommands: [pdxHelpTree.subcommands[0]],
				}),
			},
			error: "configured command path missing from generated help tree: pdx run transcript",
		},
	])("fails loudly when configured $name command cards are missing", (input) => {
		expect(() =>
			renderAgent(
				{ ...base, agent: input.agent, mode: input.mode },
				fakeRenderServices(
					agentsFile({
						agent: input.agent,
						mode: input.mode,
						harnessKind: "pi",
					}),
					input.stdout,
				),
			),
		).toThrow(input.error);
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

	it("reports live command spawn failures as stderr", () => {
		const result = LiveSpawnerServices.execFile("/tmp/pdx-missing-command", ["--help-json"]);
		expect(result.status).toBeNull();
		expect(result.stderr).toContain("ENOENT");
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
					if (path === `${dataDir}/agents.toml`) {
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
					throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
						code: "ENOENT",
					});
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: (file: string, args: readonly string[]) => {
					if (
						file.split("/").at(-1) === "pithos" &&
						args.length === 1 &&
						args[0] === "--help-json"
					) {
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
		).toThrow("contains duplicate value");
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

	it.each(["pi", "claude"] as const)(
		"inserts user argv after binary name and before Spawner flags for %s afk",
		(harnessKind) => {
			const rendered = renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				fakeRenderServices(
					agentsFile({
						agent: "war",
						mode: "afk",
						harnessKind,
						argv: ["--plugin-dir", "/tmp/my-plug"],
					}),
				),
			);
			const argv = rendered.harness.argv;
			expect(argv[0]).toBe(harnessKind);
			expect(argv[1]).toBe("--plugin-dir");
			expect(argv[2]).toBe("/tmp/my-plug");
			expect(argv[3]).toBe(
				harnessKind === "claude" ? "--dangerously-skip-permissions" : "--session",
			);
			expect(argv).toContain("--model");
			expect(argv).toContain("--print");
			expect(argv.at(-1)).toBe("Claim and process one task, then exit.");
		},
	);

	it.each(["pi", "claude"] as const)(
		"inserts user argv after binary name and before Spawner flags for %s hitl",
		(harnessKind) => {
			const rendered = renderAgent(
				{ ...base, agent: "pandora", mode: "hitl" },
				fakeRenderServices(
					agentsFile({
						agent: "pandora",
						mode: "hitl",
						harnessKind,
						argv: ["--plugin-dir", "/tmp/my-plug"],
					}),
				),
			);
			const argv = rendered.harness.argv;
			expect(argv[0]).toBe(harnessKind);
			expect(argv[1]).toBe("--plugin-dir");
			expect(argv[2]).toBe("/tmp/my-plug");
			expect(argv[3]).toBe(
				harnessKind === "claude" ? "--dangerously-skip-permissions" : "--session",
			);
			expect(argv.at(-1)).toBe("begin");
		},
	);

	it("user argv appears before tools args in rendered argv", () => {
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			fakeRenderServices(
				agentsFile({
					agent: "war",
					mode: "afk",
					harnessKind: "claude",
					argv: ["--plugin-dir", "/tmp/my-plug"],
					tools: ["bash", "read"],
				}),
			),
		);
		const argv = rendered.harness.argv;
		const pluginIndex = argv.indexOf("--plugin-dir");
		const toolsIndex = argv.indexOf("--tools");
		expect(pluginIndex).toBeGreaterThan(0);
		expect(toolsIndex).toBeGreaterThan(pluginIndex);
	});

	it("afk argv preserves shell metacharacters verbatim", () => {
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			fakeRenderServices(
				agentsFile({
					agent: "war",
					mode: "afk",
					harnessKind: "pi",
					argv: ["--flag=a'b", "''"],
				}),
			),
		);
		expect(rendered.harness.argv).toContain("--flag=a'b");
		expect(rendered.harness.argv).toContain("''");
	});

	it("manifest without argv field renders byte-identically to manifest with argv absent", () => {
		const withoutArgvField = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			fakeRenderServices(agentsFile({ agent: "war", mode: "afk", harnessKind: "claude" })),
		);
		const withExplicitEmptyArgv = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			fakeRenderServices(
				agentsFile({ agent: "war", mode: "afk", harnessKind: "claude", argv: [] }),
			),
		);
		expect(withoutArgvField.harness.argv).toEqual(withExplicitEmptyArgv.harness.argv);
	});

	it("rejects empty string elements in harness.argv at manifest decode time", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				fakeRenderServices(
					agentsFile({ agent: "war", mode: "afk", harnessKind: "pi" }).replace(
						"argv.replace = []",
						'argv.replace = ["--flag", ""]',
					),
				),
			),
		).toThrow("invalid manifest");
	});

	it("loadHooks merges bundled, user, and scopes/global manifests", () => {
		const dataDir = "/tmp/pdx-hooks-overlay";
		const userDir = `${dataDir}/config`;
		const hooks = loadHooks({
			readText: (path: string) => {
				if (path === `${dataDir}/agents.toml`)
					return agentsFile({ agent: "envy", mode: "afk", harnessKind: "pi" });
				if (path === `${userDir}/agents.toml`) return '[hooks.input]\ncommand = ["/tmp/hook"]\n';
				if (path === `${userDir}/scopes/global/agents.toml`)
					return '[hooks.input]\nenabled = true\ncommand = ["/tmp/hook", "--flag"]\n';
				throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
					code: "ENOENT",
				});
			},
			env: (key: string) => {
				if (key === "PDX_DATA_DIR") return dataDir;
				if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
				return undefined;
			},
			execFile: noopExec,
		});
		expect(hooks.input?.command).toEqual(["/tmp/hook", "--flag"]);
	});

	it("loadHooks rejects hooks in non-global scope manifests", () => {
		const dataDir = "/tmp/pdx-hooks-invalid-overlay";
		const userDir = `${dataDir}/config`;
		expect(() =>
			loadHooks({
				readText: (path: string) => {
					if (path === `${dataDir}/agents.toml`)
						return agentsFile({ agent: "envy", mode: "afk", harnessKind: "pi" });
					if (path === `${userDir}/scopes/global/agents.toml`)
						return '[hooks.input]\ncommand = ["/tmp/hook"]\n';
					if (path === `${userDir}/scopes/repo/agents.toml`)
						return '[hooks.input]\ncommand = ["/tmp/illegal"]\n';
					throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
						code: "ENOENT",
					});
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PDX_USER_DATA_DIR") return userDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: noopExec,
			}),
		).not.toThrow();
	});

	it("user scope templates override bundled templates", () => {
		const dataDir = "/tmp/pdx-layer-test";
		const userDir = `${dataDir}/config`;
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			{
				readText: (path: string) => {
					if (path === `${dataDir}/agents.toml`)
						return agentsFile({
							agent: "war",
							mode: "afk",
							harnessKind: "pi",
							includes: ["_common.md"],
						});
					if (path === `${userDir}/scopes/repo/templates/_common.md`) return "USER_SCOPE_COMMON";
					if (path === `${dataDir}/templates/_common.md`) return "BUNDLE_COMMON";
					if (path === `${dataDir}/templates/war.md`)
						return "{{_common.md}} {{claim_command}}\n{{command_cards}}";
					throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
						code: "ENOENT",
					});
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PDX_USER_DATA_DIR") return userDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: (file: string, args: readonly string[]) =>
					file.split("/").at(-1) === "pithos" && args[0] === "--help-json"
						? { status: 0, stdout: pithosHelpJson, stderr: "" }
						: { status: 1, stdout: "", stderr: `unexpected execFile call: ${file}` },
			},
		);
		expect(rendered.prompt).toContain("USER_SCOPE_COMMON");
		expect(rendered.prompt).not.toContain("BUNDLE_COMMON");
	});

	it("template.default restores the bundled template file and ignores higher-priority template assets", () => {
		const dataDir = "/tmp/pdx-template-default";
		const userDir = `${dataDir}/config`;
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			{
				readText: (path: string) => {
					if (path === `${dataDir}/agents.toml`)
						return agentsFile({ agent: "war", mode: "afk", harnessKind: "pi" });
					if (path === `${userDir}/agents.toml`) return "[agents.war]\ntemplate.default = true\n";
					if (path === `${userDir}/templates/war.md`) return "USER_TEMPLATE";
					if (path === `${dataDir}/templates/_common.md`) return "BUNDLE_COMMON";
					if (path === `${dataDir}/templates/war.md`)
						return "BUNDLED_TEMPLATE {{claim_command}}\n{{command_cards}}";
					throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
						code: "ENOENT",
					});
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PDX_USER_DATA_DIR") return userDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: (file: string, args: readonly string[]) =>
					file.split("/").at(-1) === "pithos" && args[0] === "--help-json"
						? { status: 0, stdout: pithosHelpJson, stderr: "" }
						: { status: 1, stdout: "", stderr: `unexpected execFile call: ${file}` },
			},
		);
		expect(rendered.prompt).toContain("BUNDLED_TEMPLATE");
		expect(rendered.prompt).not.toContain("USER_TEMPLATE");
	});

	it("appends render after template body joined by separator in declared order", () => {
		const dataDir = "/tmp/pdx-appends-test";
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			{
				readText: (path: string) => {
					if (path === `${dataDir}/agents.toml`)
						return agentsFile({
							agent: "war",
							mode: "afk",
							harnessKind: "pi",
							includes: [],
							appends: ["extra-a.md", "extra-b.md"],
							template: "war.md",
						});
					if (path === `${dataDir}/templates/war.md`)
						return "TEMPLATE_BODY {{claim_command}}\n{{command_cards}}";
					if (path === `${dataDir}/templates/extra-a.md`) return "APPEND_A";
					if (path === `${dataDir}/templates/extra-b.md`) return "APPEND_B";
					throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
						code: "ENOENT",
					});
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: (file: string, args: readonly string[]) =>
					file.split("/").at(-1) === "pithos" && args[0] === "--help-json"
						? { status: 0, stdout: pithosHelpJson, stderr: "" }
						: { status: 1, stdout: "", stderr: `unexpected execFile call: ${file}` },
			},
		);
		expect(rendered.prompt).toContain("TEMPLATE_BODY");
		expect(rendered.prompt).toContain("APPEND_A");
		expect(rendered.prompt).toContain("APPEND_B");
		expect(rendered.prompt.indexOf("APPEND_A")).toBeLessThan(rendered.prompt.indexOf("APPEND_B"));
	});

	it("remove of an absent unique-list value fails loudly", () => {
		const dataDir = "/tmp/pdx-list-remove-error";
		const userDir = `${dataDir}/config`;
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				{
					readText: (path: string) => {
						if (path === `${dataDir}/agents.toml`)
							return agentsFile({ agent: "war", mode: "afk", harnessKind: "pi" });
						if (path === `${userDir}/agents.toml`)
							return '[agents.war.includes]\nremove = ["missing.md"]\n';
						throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
							code: "ENOENT",
						});
					},
					env: (key: string) => {
						if (key === "PDX_DATA_DIR") return dataDir;
						if (key === "PDX_USER_DATA_DIR") return userDir;
						if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
						return undefined;
					},
					execFile: noopExec,
				},
			),
		).toThrow("cannot remove absent value");
	});

	it("prompt without appends has no separator", () => {
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			fakeRenderServices(agentsFile({ agent: "war", mode: "afk", harnessKind: "pi" })),
		);
		expect(rendered.prompt).not.toContain("\n\n---\n\n");
	});

	it("records preview provenance for repo layered template resolution", () => {
		const dataDir = "/tmp/pdx-provenance-repo";
		const userDir = `${dataDir}/config`;
		const repoDir = "/tmp/repos/demo";
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk", scopeId: `repo:${repoDir}`, cwd: repoDir },
			{
				readText: (path: string) => {
					if (path === `${dataDir}/agents.toml`) {
						return agentsFile({
							agent: "war",
							mode: "afk",
							harnessKind: "pi",
							includes: ["_common.md"],
						});
					}
					if (path === `${userDir}/scopes/repo/agents.toml`)
						return '[agents.war]\ntemplate = "war.md"\n';
					if (path === `${repoDir}/.pdx/scopes/repo/templates/_common.md`)
						return "PROJECT_SCOPE_COMMON";
					if (path === `${repoDir}/.pdx/scopes/repo/templates/war.md`)
						return "PROJECT_SCOPE_TEMPLATE {{_common.md}} {{claim_command}}\n{{command_cards}}";
					if (path === `${dataDir}/templates/_common.md`) return "BUNDLED_COMMON";
					if (path === `${dataDir}/templates/war.md`)
						return "BUNDLED_TEMPLATE {{_common.md}} {{claim_command}}\n{{command_cards}}";
					throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
						code: "ENOENT",
					});
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PDX_USER_DATA_DIR") return userDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: (file: string, args: readonly string[]) =>
					file.split("/").at(-1) === "pithos" && args[0] === "--help-json"
						? { status: 0, stdout: pithosHelpJson, stderr: "" }
						: { status: 1, stdout: "", stderr: `unexpected execFile call: ${file}` },
			},
		);
		expect(rendered.prompt).toContain("PROJECT_SCOPE_TEMPLATE PROJECT_SCOPE_COMMON");
		const provenance = rendered.provenance;
		expect(provenance).toBeDefined();
		expect(provenance!.layers.map((layer) => layer.kind)).toEqual([
			"bundled",
			"user",
			"user-scope",
			"project",
			"project-scope",
		]);
		expect(provenance!.template.resolved.path).toBe(`${repoDir}/.pdx/scopes/repo/templates/war.md`);
		expect(provenance!.template.resolved.source).toMatchObject({
			type: "layer",
			kind: "project-scope",
			scopeKind: "repo",
			rootDir: `${repoDir}/.pdx/scopes/repo`,
		});
		expect(provenance!.includes).toEqual([
			{
				reference: "_common.md",
				path: `${repoDir}/.pdx/scopes/repo/templates/_common.md`,
				source: {
					type: "layer",
					kind: "project-scope",
					scopeKind: "repo",
					rootDir: `${repoDir}/.pdx/scopes/repo`,
				},
			},
		]);
	});

	it("requires parentRepoPath for worktree layered config resolution", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk", scopeId: "worktree:/tmp/wt", cwd: "/tmp/wt" },
				fakeRenderServices(agentsFile({ agent: "war", mode: "afk", harnessKind: "pi" })),
			),
		).toThrow("requires parentRepoPath");
	});

	it("rejects project-local .pdx/scopes/global manifests for repo renders", () => {
		const dataDir = "/tmp/pdx-project-global-repo";
		const repoDir = "/tmp/repos/demo";
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk", scopeId: `repo:${repoDir}`, cwd: repoDir },
				{
					readText: (path: string) => {
						if (path === `${dataDir}/agents.toml`) {
							return agentsFile({ agent: "war", mode: "afk", harnessKind: "pi" });
						}
						if (path === `${repoDir}/.pdx/scopes/global/agents.toml`) {
							return '[agents.war]\ntemplate = "war.md"\n';
						}
						if (path === `${dataDir}/templates/_common.md`) return "BUNDLED_COMMON";
						if (path === `${dataDir}/templates/war.md`) {
							return "BUNDLED_TEMPLATE {{_common.md}} {{claim_command}}\n{{command_cards}}";
						}
						throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
							code: "ENOENT",
						});
					},
					env: (key: string) => {
						if (key === "PDX_DATA_DIR") return dataDir;
						if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
						return undefined;
					},
					execFile: noopExec,
				},
			),
		).toThrow("project-local .pdx may not define scopes/global");
	});

	it("rejects project-local .pdx/scopes/global manifests for worktree renders", () => {
		const dataDir = "/tmp/pdx-project-global-worktree";
		const worktreeDir = "/tmp/wt/demo";
		const parentRepoDir = "/tmp/repos/demo";
		expect(() =>
			renderAgent(
				{
					...base,
					agent: "war",
					mode: "afk",
					scopeId: `worktree:${worktreeDir}`,
					cwd: worktreeDir,
					parentRepoPath: parentRepoDir,
				},
				{
					readText: (path: string) => {
						if (path === `${dataDir}/agents.toml`) {
							return agentsFile({ agent: "war", mode: "afk", harnessKind: "pi" });
						}
						if (path === `${parentRepoDir}/.pdx/scopes/global/agents.toml`) {
							return '[agents.war]\ntemplate = "war.md"\n';
						}
						if (path === `${dataDir}/templates/_common.md`) return "BUNDLED_COMMON";
						if (path === `${dataDir}/templates/war.md`) {
							return "BUNDLED_TEMPLATE {{_common.md}} {{claim_command}}\n{{command_cards}}";
						}
						throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
							code: "ENOENT",
						});
					},
					env: (key: string) => {
						if (key === "PDX_DATA_DIR") return dataDir;
						if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
						return undefined;
					},
					execFile: noopExec,
				},
			),
		).toThrow("project-local .pdx may not define scopes/global");
	});

	it("uses parent repo config for worktree previews and reports absolute-template provenance", () => {
		const dataDir = "/tmp/pdx-provenance-worktree";
		const userDir = `${dataDir}/config`;
		const worktreeDir = "/tmp/wt/demo";
		const parentRepoDir = "/tmp/repos/demo";
		const absoluteTemplate = "/tmp/custom/war.md";
		const rendered = renderAgent(
			{
				...base,
				agent: "war",
				mode: "afk",
				scopeId: `worktree:${worktreeDir}`,
				cwd: worktreeDir,
				parentRepoPath: parentRepoDir,
			},
			{
				readText: (path: string) => {
					if (path === `${dataDir}/agents.toml`)
						return agentsFile({ agent: "war", mode: "afk", harnessKind: "pi" });
					if (path === `${userDir}/scopes/worktree/templates/_common.md`) return "WORKTREE_COMMON";
					if (path === `${parentRepoDir}/.pdx/scopes/worktree/agents.toml`) {
						return `[agents.war]\ntemplate = ${quoteTomlString(absoluteTemplate)}\n`;
					}
					if (path === absoluteTemplate)
						return "ABSOLUTE_TEMPLATE {{_common.md}} {{claim_command}}\n{{command_cards}}";
					if (path === `${dataDir}/templates/_common.md`) return "BUNDLED_COMMON";
					if (path === `${dataDir}/templates/war.md`)
						return "BUNDLED_TEMPLATE {{_common.md}} {{claim_command}}\n{{command_cards}}";
					throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
						code: "ENOENT",
					});
				},
				env: (key: string) => {
					if (key === "PDX_DATA_DIR") return dataDir;
					if (key === "PDX_USER_DATA_DIR") return userDir;
					if (key === "PITHOS_DB") return `${dataDir}/pithos.sqlite`;
					return undefined;
				},
				execFile: (file: string, args: readonly string[]) =>
					file.split("/").at(-1) === "pithos" && args[0] === "--help-json"
						? { status: 0, stdout: pithosHelpJson, stderr: "" }
						: { status: 1, stdout: "", stderr: `unexpected execFile call: ${file}` },
			},
		);
		expect(rendered.prompt).toContain("ABSOLUTE_TEMPLATE WORKTREE_COMMON");
		const provenance = rendered.provenance;
		expect(provenance).toBeDefined();
		expect(provenance!.layers.map((layer) => layer.kind)).toEqual([
			"bundled",
			"user",
			"user-scope",
			"project",
			"project-scope",
		]);
		expect(provenance!.template).toEqual({
			reference: absoluteTemplate,
			pinnedToBundled: false,
			resolved: {
				reference: absoluteTemplate,
				path: absoluteTemplate,
				source: { type: "absolute" },
			},
		});
		expect(provenance!.includes[0]).toMatchObject({
			path: `${userDir}/scopes/worktree/templates/_common.md`,
			source: { type: "layer", kind: "user-scope", scopeKind: "worktree" },
		});
	});

	it("fails loudly when a resolved template asset is missing from every layer", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				{
					readText: (path: string) => {
						if (path.endsWith("agents.toml")) {
							return agentsFile({
								agent: "war",
								mode: "afk",
								harnessKind: "pi",
								includes: ["missing.md"],
							});
						}
						if (path.endsWith("war.md"))
							return "{{missing.md}} {{claim_command}}\n{{command_cards}}";
						throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
							code: "ENOENT",
						});
					},
					env: (key: string) =>
						key === "PDX_DATA_DIR"
							? "/tmp/pdx-missing-template"
							: key === "PITHOS_DB"
								? "/tmp/pdx-missing-template/pithos.sqlite"
								: undefined,
					execFile: noopExec,
				},
			),
		).toThrow("template asset not found in any config layer: missing.md");
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
			provenance: {
				layers: [],
				template: {
					reference: "war.md",
					pinnedToBundled: false,
					resolved: {
						reference: "war.md",
						path: "/tmp/war.md",
						source: { type: "layer", kind: "bundled", scopeKind: "global", rootDir: "/tmp" },
					},
				},
				includes: [],
				appends: [],
			},
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
				{ ...base, agent: "pandora", mode: "hitl" },
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
			expect(hitl.hitl).toEqual({ tmuxTarget: rendered.logicalName, panePid: 5678 });
			expect(tmuxNewSessionArgs).toContain("sh");
			expect(tmuxNewSessionArgs).toContain("-c");
			expect(tmuxNewSessionArgs.join("\0")).not.toContain(rendered.prompt);
			expect(tmuxNewSessionArgs.join("\0")).toContain("$(cat '/tmp/pithos-spawner-prompt-");
		},
	);

	it("user argv containing --append-system-prompt does not hijack HITL prompt delivery", () => {
		const rendered = renderAgent(
			{ ...base, agent: "pandora", mode: "hitl" },
			fakeRenderServices(
				agentsFile({
					agent: "pandora",
					mode: "hitl",
					harnessKind: "claude",
					argv: ["--append-system-prompt", "FAKE_PROMPT"],
					harnessMode: "append",
				}),
			),
		);
		let tmuxNewSessionArgs: readonly string[] = [];
		launchRenderedAgent(
			rendered,
			makeLaunchServices("", {
				exitCode: 0,
				panePid: 5678,
				onTmuxNewSession: (args) => {
					tmuxNewSessionArgs = args;
				},
			}),
		);
		// Spawner's rendered prompt must go through the temp file, not inline
		expect(tmuxNewSessionArgs.join("\0")).not.toContain(rendered.prompt);
		expect(tmuxNewSessionArgs.join("\0")).toContain("$(cat '/tmp/pithos-spawner-prompt-");
		// User argv's fake --append-system-prompt appears literally in the beforePrompt section
		expect(tmuxNewSessionArgs.join("\0")).toContain("'--append-system-prompt' 'FAKE_PROMPT'");
	});

	it("shell metacharacters in user argv are safely quoted in HITL sh -c script", () => {
		const rendered = renderAgent(
			{ ...base, agent: "pandora", mode: "hitl" },
			fakeRenderServices(
				agentsFile({
					agent: "pandora",
					mode: "hitl",
					harnessKind: "pi",
					argv: ["--flag=a'b"],
					harnessMode: "append",
				}),
			),
		);
		let tmuxNewSessionArgs: readonly string[] = [];
		launchRenderedAgent(
			rendered,
			makeLaunchServices("", {
				exitCode: 0,
				panePid: 5678,
				onTmuxNewSession: (args) => {
					tmuxNewSessionArgs = args;
				},
			}),
		);
		// shellQuote("--flag=a'b") = "'--flag=a'\"'\"'b'"
		expect(tmuxNewSessionArgs.join("\0")).toContain("'--flag=a'\"'\"'b'");
	});
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
