import { CliConfig, Command } from "@effect/cli";
import { NodeContext } from "@effect/platform-node";
import Database from "better-sqlite3";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makePithosCommand, PithosError, type Services } from "../src/index.js";

const tempDb = () => join(mkdtempSync(join(tmpdir(), "pithos-cli-")), "pithos.db");

const services = (
	stdin:
		| { readonly _tag: "NoRedirectedStdin" }
		| { readonly _tag: "RedirectedText"; readonly text: string }
		| { readonly _tag: "ReadFailure"; readonly error: PithosError } = { _tag: "NoRedirectedStdin" },
): Services & { stdout: string[]; stderr: string[] } => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		fs: {
			readText: () => Effect.succeed("body"),
			removeFile: (path) => Effect.sync(() => rmSync(path, { force: true })),
		},
		input: {
			readStdin: () => Effect.succeed(stdin),
		},
		output: {
			write: (text) => Effect.sync(() => void stdout.push(text)),
			writeError: (text) => Effect.sync(() => void stderr.push(text)),
		},
		ids: { make: (prefix) => Effect.succeed(`${prefix}_cli_${stdout.length}_${stderr.length}`) },
		clock: { nowIso: () => Effect.succeed("2026-05-08T00:00:00.000Z") },
	};
};

const runCli = async (
	args: readonly string[],
	dbPath: string,
	stdin?: Parameters<typeof services>[0],
) => {
	process.exitCode = undefined;
	const svc = services(stdin);
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
		executable: "pithos",
	});
	await Effect.runPromise(
		cli(["node", "pithos", ...args]).pipe(
			Effect.provide(Layer.mergeAll(NodeContext.layer, CliConfig.layer({ showBuiltIns: false }))),
		),
	);
	return { ...svc, configRead, exitCode: process.exitCode };
};

afterEach(() => {
	process.exitCode = undefined;
});

describe("pithos cli", () => {
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
				"--harness-kind",
				"pi",
				"--session-log-path",
				"/tmp/session_cli.jsonl",
				"--run",
				"run_cli",
			],
			dbPath,
		);
		expect(JSON.parse(upsert.stdout[0] ?? "")).toMatchObject({
			ok: true,
			run: {
				id: "run_cli",
				agent: "war",
				mode: "afk",
				status: "live",
				harness_kind: "pi",
				session_log_path: "/tmp/session_cli.jsonl",
			},
		});

		const inspect = await runCli(["run", "inspect", "run_cli"], dbPath);
		expect(JSON.parse(inspect.stdout[0] ?? "")).toMatchObject({
			ok: true,
			run: {
				id: "run_cli",
				session_id: "session_cli",
				harness_kind: "pi",
				session_log_path: "/tmp/session_cli.jsonl",
			},
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
				"--harness-kind",
				"claude",
				"--session-log-path",
				"/tmp/session.jsonl",
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
				"--harness-kind",
				"claude",
				"--session-log-path",
				"/tmp/session.jsonl",
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

	it("enqueues multiline task bodies from explicit stdin", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await runCli(
			[
				"run",
				"upsert",
				"--agent",
				"pandora",
				"--mode",
				"hitl",
				"--scope",
				"global",
				"--cwd",
				"/tmp",
				"--session-id",
				"session",
				"--harness-kind",
				"pi",
				"--session-log-path",
				"/tmp/session.jsonl",
				"--run",
				"run_pandora",
			],
			dbPath,
		);

		const enqueue = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"stdin task",
				"--stdin",
				"--run",
				"run_pandora",
			],
			dbPath,
			{ _tag: "RedirectedText", text: "line 1\nline 2\n" },
		);
		const created = JSON.parse(enqueue.stdout[0] ?? "") as { task: { id: string } };
		const inspect = await runCli(["task", "inspect", created.task.id], dbPath);
		const inspected = JSON.parse(inspect.stdout[0] ?? "") as {
			readonly ok: true;
			readonly dependencies: readonly unknown[];
			readonly task: { readonly title: string };
		};
		expect(inspected).toMatchObject({
			ok: true,
			dependencies: [],
		});
		expect(inspected.dependencies).toEqual([]);
		expect(inspected.task.title).toBe("stdin task");
		const db = new Database(dbPath, { readonly: true });
		try {
			expect(db.prepare("SELECT body FROM tasks WHERE id = ?").pluck().get(created.task.id)).toBe(
				"line 1\nline 2\n",
			);
		} finally {
			db.close();
		}
	});

	it("returns validation JSON when enqueue omits --stdin", async () => {
		const result = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"missing stdin",
			],
			tempDb(),
		);
		expect(JSON.parse(result.stderr[0] ?? "")).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_ERROR" },
		});
		expect(result.exitCode).toBe(2);
		expect(result.configRead).toBe(false);
	});

	it("validates required stdin availability and non-empty content", async () => {
		for (const stdin of [
			{ _tag: "NoRedirectedStdin" as const },
			{ _tag: "RedirectedText" as const, text: "" },
		]) {
			const result = await runCli(
				[
					"task",
					"enqueue",
					"--scope",
					"global",
					"--capability",
					"triage",
					"--title",
					"bad stdin",
					"--stdin",
				],
				tempDb(),
				stdin,
			);
			expect(JSON.parse(result.stderr[0] ?? "")).toMatchObject({
				ok: false,
				error: { code: "VALIDATION_ERROR" },
			});
			expect(result.exitCode).toBe(2);
		}
	});

	it("surfaces stdin read failures as tagged JSON", async () => {
		const result = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"read failure",
				"--stdin",
			],
			tempDb(),
			{
				_tag: "ReadFailure",
				error: new PithosError({ code: "USER_ERROR", message: "stdin exploded" }),
			},
		);
		expect(JSON.parse(result.stderr[0] ?? "")).toEqual({
			ok: false,
			error: { code: "USER_ERROR", message: "stdin exploded" },
		});
	});

	it("renders help without loading config", async () => {
		const result = await runCli(["--help"], tempDb());
		expect(result.configRead).toBe(false);
	});
});
