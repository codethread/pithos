import { describe, expect, it } from "vitest";
import { SpawnerError } from "./errors.js";
import { renderAgent } from "./spawner.js";

const base = {
	runId: "run_test",
	sessionId: "session_test",
	scopeId: "scope_repo",
	cwd: "/tmp/repo",
} as const;

const agentsFile = (
	agent: string,
	mode: string,
	claims: readonly string[],
	enqueues: readonly string[],
) =>
	JSON.stringify({
		agents: [
			{
				agent,
				mode,
				claims,
				enqueues,
				harness: { kind: "claude" },
				template: `${agent}.md.tmpl`,
			},
		],
	});

const fakeRenderServices = (agentsJson: string) => ({
	readText: (path: string) => (path.endsWith("agents.json") ? agentsJson : "{{claim_command}}"),
	env: () => undefined,
	home: () => "/home/test",
});

describe("renderAgent", () => {
	it.each([
		["pandora", "hitl", "escalate"],
		["toil", "afk", "triage"],
		["greed", "hitl", "design"],
		["war", "afk", "execute"],
	] as const)("renders required shape and claim command for %s", (agent, mode, capability) => {
		const rendered = renderAgent({ ...base, agent, mode });

		expect(rendered).toMatchObject({
			agent,
			mode,
			runId: base.runId,
			sessionId: base.sessionId,
			scopeId: base.scopeId,
			cwd: base.cwd,
		});
		expect(rendered.logicalName).toContain(`pdx--${agent}`);
		expect(rendered.harness.argv.length).toBeGreaterThan(0);
		expect(rendered.harness.env.PITHOS_RUN_ID).toBe(base.runId);
		expect(rendered.prompt).toContain(
			`pithos task claim --run ${base.runId} --scope ${base.scopeId} --capability ${capability}`,
		);
	});

	it("rejects mode mismatch", () => {
		expect(() => renderAgent({ ...base, agent: "war", mode: "hitl" })).toThrow(SpawnerError);
	});

	it("rejects manifest claim drift from built-in contract", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				fakeRenderServices(agentsFile("war", "afk", ["triage"], ["escalate"])),
			),
		).toThrow(SpawnerError);
	});

	it("rejects multi-claim manifests", () => {
		expect(() =>
			renderAgent(
				{ ...base, agent: "war", mode: "afk" },
				fakeRenderServices(agentsFile("war", "afk", ["execute", "triage"], ["escalate"])),
			),
		).toThrow(SpawnerError);
	});
});
