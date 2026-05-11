import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_ENQUEUES } from "@pithos/pithos/builtins";
import { SpawnerError } from "./errors.js";
import { launchRenderedAgent, renderAgent, renderSessionTranscript } from "./spawner.js";

const templateDir = join(dirname(fileURLToPath(import.meta.url)), "../templates");

const base = {
	runId: "run_test",
	sessionId: "123e4567-e89b-12d3-a456-426614174000",
	scopeId: "scope_repo",
	cwd: "/tmp/repo",
} as const;

const piBucket = (cwd: string): string => `--${cwd.replace(/^\/+/, "").replace(/[/:\\]/g, "-")}--`;
const claudeSessionPath = (cwd: string, sessionId: string): string =>
	`${homedir()}/.claude/projects/${cwd.replace(/^\/+/, "").replace(/[/:\\]/g, "-")}/${sessionId}.jsonl`;
const piSessionPath = (cwd: string, sessionId: string): string =>
	`${homedir()}/.pi/agent/sessions/${piBucket(cwd)}/${sessionId}.jsonl`;

const agentsFile = ({
	agent,
	mode,
	harnessKind,
	claims,
	enqueues,
	tools,
	harnessMode = "append",
	includes = ["_common.md"],
}: {
	agent: string;
	mode: string;
	harnessKind: "claude" | "pi";
	claims: readonly string[];
	enqueues: readonly string[];
	tools?: readonly string[];
	harnessMode?: "replace" | "append";
	includes?: readonly string[];
}): string =>
	JSON.stringify({
		agents: [
			{
				agent,
				mode,
				claims,
				enqueues,
				harness: {
					kind: harnessKind,
					model: "model_test",
					system_prompt_mode: harnessMode,
					...(tools === undefined ? {} : { tools }),
				},
				includes,
				template: `${agent}.md.tmpl`,
			},
		],
	});

const fakeRenderServices = (agentsJson: string) =>
	({
		readText: (path: string) => {
			if (path.endsWith("agents.json")) return agentsJson;
			if (path.endsWith("_common.md")) return "COMMON";
			if (path.endsWith("war.md.tmpl")) {
				return "{{_common.md}} {{model}} {{tools_csv}} {{claims}} {{enqueues}} {{claim_command}}";
			}
			return "";
		},
		env: (key: string) => (key === "PDX_DATA_DIR" ? "/tmp/pdx-data" : undefined),
	}) as const;

const makeLaunchServices = (
	agentsJson: string,
	{
		spawnPid,
		tmuxStatus,
		exitCode = 0,
		panePid,
	}: {
		spawnPid?: number;
		tmuxStatus?: string;
		exitCode?: number;
		panePid?: number;
	},
) =>
	({
		...fakeRenderServices(agentsJson),
		spawnProcess: () => (spawnPid === undefined ? {} : { pid: spawnPid }),
		execFile: (file: string, args: readonly string[]) => {
			if (file === "tmux") {
				if (args[0] === "new-session") {
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
			.filter((entry) => entry.endsWith(".md") || entry.endsWith(".tmpl"))
			.map((entry) => readFileSync(join(templateDir, entry), "utf8"))
			.join("\n");

		expect(templateText).not.toContain("--body");
		expect(templateText).not.toContain("--body-file");
		expect(templateText).not.toContain("--result-file");
		expect(templateText).toContain("For any Pithos command using `--stdin`");
		expect(templateText).toContain("<<'EOF'");
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
					claims: ["execute"],
					enqueues: ["escalate"],
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
		expect(rendered.harness.argv).toContain("--tools");
		expect(rendered.harness.argv).toContain("bash,read");
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
						claims: ["execute"],
						enqueues: ["escalate"],
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
						claims: ["execute"],
						enqueues: ["escalate"],
					}),
				),
			),
		).toThrow("sessionId must be a UUID");
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
						claims: ["execute"],
						enqueues: ["escalate"],
						includes: ["sub/evil.md"],
					}),
				),
			),
		).toThrow("include must be a template basename");

		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				fakeRenderServices(
					agentsFile({
						agent: "war",
						mode: "afk",
						harnessKind: "pi",
						claims: ["execute"],
						enqueues: ["escalate"],
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
							claims: ["execute"],
							enqueues: ["escalate"],
						}),
					).readText,
					env: () => undefined,
				},
			),
		).toThrow("PITHOS_DB or PDX_DATA_DIR is required for spawner render/preview");
	});
});

describe("launchRenderedAgent", () => {
	it("returns runtime metadata without rendered argv/env", () => {
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "afk" },
			fakeRenderServices(
				agentsFile({
					agent: "war",
					mode: "afk",
					harnessKind: "pi",
					claims: ["execute"],
					enqueues: ["escalate"],
				}),
			),
		);
		const launched = launchRenderedAgent(rendered, makeLaunchServices("", { spawnPid: 1234 }));
		expect(launched.afk?.pid).toBe(1234);
		expect(launched.sessionLogPath).toBe(rendered.sessionLogPath);
		expect("harnessArgv" in launched).toBe(false);
		expect("harnessEnvKeys" in launched).toBe(false);
	});

	it("launches hitl through tmux when requested", () => {
		const rendered = renderAgent(
			{ ...base, agent: "war", mode: "hitl" },
			fakeRenderServices(
				agentsFile({
					agent: "war",
					mode: "hitl",
					harnessKind: "pi",
					claims: ["execute"],
					enqueues: ["escalate"],
					harnessMode: "append",
				}),
			),
		);
		const hitl = launchRenderedAgent(
			rendered,
			makeLaunchServices("", { exitCode: 0, panePid: 5678, tmuxStatus: "ignored" }),
		);
		expect(hitl.hitl).toEqual({ tmuxTarget: "pdx--war__scope-repo--123e4567", panePid: 5678 });
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

	it("fails loudly on missing or corrupt logs", () => {
		expect(() =>
			renderSessionTranscript(
				{ harnessKind: "pi", sessionLogPath: "missing.jsonl" },
				{
					readText: () => "not-json\n",
					env: () => undefined,
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
				},
			),
		).toThrow(/required message\.content must be an array/);
	});
});

// Smoke-check contract for required claim/enqueue pairs.
describe("manifest contract", () => {
	it("rejects claim drift from built-in contract", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				fakeRenderServices(
					agentsFile({
						agent: "war",
						mode: "afk",
						harnessKind: "pi",
						claims: ["triage"],
						enqueues: BUILTIN_AGENT_ENQUEUES.war,
					}),
				),
			),
		).toThrow(SpawnerError);
	});

	it("rejects multi-claim manifests", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				fakeRenderServices(
					agentsFile({
						agent: "war",
						mode: "afk",
						harnessKind: "pi",
						claims: ["execute", "triage"],
						enqueues: BUILTIN_AGENT_ENQUEUES.war,
					}),
				),
			),
		).toThrow(SpawnerError);
	});
});
