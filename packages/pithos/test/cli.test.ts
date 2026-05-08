import { CliConfig, Command } from "@effect/cli";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makePithosCommand, type Services } from "../src/index.js";

const tempDb = () => join(mkdtempSync(join(tmpdir(), "pithos-next-cli-")), "pithos.db");

const services = (): Services & { stdout: string[]; stderr: string[] } => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		fs: { readText: () => "body", removeFile: (path) => rmSync(path, { force: true }) },
		output: { write: (text) => stdout.push(text), writeError: (text) => stderr.push(text) },
		ids: { make: (prefix) => `${prefix}_cli_${stdout.length}_${stderr.length}` },
		clock: { nowIso: () => "2026-05-08T00:00:00.000Z" },
	};
};

const runCli = async (args: readonly string[], dbPath: string) => {
	process.exitCode = undefined;
	const svc = services();
	let configRead = false;
	const command = makePithosCommand({
		config: () => {
			configRead = true;
			return { dbPath };
		},
		services: svc,
	});
	const cli = Command.run(command, {
		name: "Pithos",
		version: "0.1.0",
		executable: "pithos-next",
	});
	await Effect.runPromise(
		cli(["node", "pithos-next", ...args]).pipe(
			Effect.provide(Layer.mergeAll(NodeContext.layer, CliConfig.layer({ showBuiltIns: false }))),
		),
	);
	return { ...svc, configRead, exitCode: process.exitCode };
};

afterEach(() => {
	process.exitCode = undefined;
});

describe("pithos-next cli", () => {
	it("dispatches nested scope/run/events commands with JSON output", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		const scope = await runCli(
			["scope", "upsert", "--kind", "repo", "--path", "/tmp/pithos-cli"],
			dbPath,
		);
		const scopeBody = JSON.parse(scope.stdout[0] ?? "") as { scope: { id: string } };
		expect(scopeBody.scope.id).toBe("repo:/tmp/pithos-cli");

		const upsert = await runCli(
			[
				"run",
				"upsert",
				"--agent",
				"war",
				"--mode",
				"afk",
				"--scope",
				scopeBody.scope.id,
				"--cwd",
				"/tmp/pithos-cli",
				"--session-id",
				"session_cli",
				"--run",
				"run_cli",
			],
			dbPath,
		);
		expect(JSON.parse(upsert.stdout[0] ?? "")).toMatchObject({
			ok: true,
			run: { id: "run_cli", agent: "war", mode: "afk", status: "live" },
		});

		const inspect = await runCli(["run", "inspect", "run_cli"], dbPath);
		expect(JSON.parse(inspect.stdout[0] ?? "")).toMatchObject({
			ok: true,
			run: { id: "run_cli", session_id: "session_cli" },
		});

		const events = await runCli(["events", "tail", "--limit", "1"], dbPath);
		expect(JSON.parse(events.stdout[0] ?? "")).toEqual({ ok: true, events: [] });
	});

	it("defers run agent validation to Pithos and renders PithosError JSON", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		const result = await runCli(
			[
				"run",
				"upsert",
				"--agent",
				"unknown",
				"--mode",
				"afk",
				"--scope",
				"global",
				"--cwd",
				"/tmp",
				"--session-id",
				"session",
			],
			dbPath,
		);
		const errors: unknown[] = result.stderr.map((line) => JSON.parse(line) as unknown);
		expect(errors).toEqual([
			{
				ok: false,
				error: { code: "VALIDATION_ERROR", message: "unknown agent kind: unknown" },
			},
		]);
		expect(result.exitCode).toBe(2);
	});

	it("renders PithosError failures as JSON", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		const result = await runCli(
			[
				"run",
				"upsert",
				"--agent",
				"war",
				"--mode",
				"afk",
				"--scope",
				"repo:/missing",
				"--cwd",
				"/tmp",
				"--session-id",
				"session",
			],
			dbPath,
		);
		const errors: unknown[] = result.stderr.map((line) => JSON.parse(line) as unknown);
		expect(errors).toEqual([
			{
				ok: false,
				error: { code: "NOT_FOUND", message: "scope not found: repo:/missing" },
			},
		]);
		expect(result.exitCode).toBe(3);
	});

	it("renders help without loading config", async () => {
		const result = await runCli(["--help"], tempDb());
		expect(result.configRead).toBe(false);
	});
});
