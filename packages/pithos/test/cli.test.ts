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

let idCounter = 0;

const services = (
	stdin:
		| { readonly _tag: "NoRedirectedStdin" }
		| { readonly _tag: "RedirectedText"; readonly text: string }
		| { readonly _tag: "ReadFailure"; readonly error: PithosError } = { _tag: "NoRedirectedStdin" },
): Services & { stdout: string[]; stderr: string[]; stdinReads: () => number } => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let stdinReadCount = 0;

	return {
		stdout,
		stderr,
		stdinReads: () => stdinReadCount,
		fs: {
			readText: () => Effect.succeed("body"),
			removeFile: (path) => Effect.sync(() => rmSync(path, { force: true })),
		},
		input: {
			readStdin: () =>
				Effect.sync(() => {
					stdinReadCount += 1;
					return stdin;
				}),
		},
		output: {
			write: (text) => Effect.sync(() => void stdout.push(text)),
			writeError: (text) => Effect.sync(() => void stderr.push(text)),
		},
		ids: { make: (prefix) => Effect.sync(() => `${prefix}_cli_${idCounter++}`) },
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

const upsertRun = (dbPath: string, runId: string, agent = "toil") =>
	runCli(
		[
			"run",
			"upsert",
			"--agent",
			agent,
			"--mode",
			agent === "pandora" ? "hitl" : "afk",
			"--scope",
			"global",
			"--cwd",
			"/tmp",
			"--session-id",
			`session_${runId}`,
			"--harness-kind",
			"pi",
			"--session-log-path",
			`/tmp/session_${runId}.jsonl`,
			"--run",
			runId,
		],
		dbPath,
	);

const upsertRepoWarRun = (dbPath: string) =>
	runCli(
		[
			"run",
			"upsert",
			"--agent",
			"war",
			"--mode",
			"afk",
			"--scope",
			"repo:/tmp/pithos-cli",
			"--cwd",
			"/tmp/pithos-cli",
			"--session-id",
			"session_run_war",
			"--harness-kind",
			"pi",
			"--session-log-path",
			"/tmp/session_run_war.jsonl",
			"--run",
			"run_war",
		],
		dbPath,
	);

const enqueueGlobalTriage = async (dbPath: string, runId: string, title: string, body: string) => {
	const result = await runCli(
		[
			"task",
			"enqueue",
			"--scope",
			"global",
			"--capability",
			"triage",
			"--title",
			title,
			"--stdin",
			"--run",
			runId,
		],
		dbPath,
		{ _tag: "RedirectedText", text: body },
	);
	return (JSON.parse(result.stdout[0] ?? "") as { task: { id: string } }).task.id;
};

const taskBody = (dbPath: string, taskId: string) => {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT body FROM tasks WHERE id = ?").pluck().get(taskId);
	} finally {
		db.close();
	}
};

const artifactBody = (dbPath: string, artifactId: string) => {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT body FROM artifacts WHERE id = ?").pluck().get(artifactId);
	} finally {
		db.close();
	}
};

const taskResultJson = (dbPath: string, taskId: string) => {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT result_json FROM tasks WHERE id = ?").pluck().get(taskId);
	} finally {
		db.close();
	}
};

const artifactAddArgs = (taskId = "task_missing", extra: readonly string[] = []) => [
	"task",
	"artifact",
	"add",
	"--task",
	taskId,
	"--kind",
	"note",
	"--title",
	"evidence",
	...extra,
];

const completeArgs = (taskId: string, extra: readonly string[] = []) => [
	"task",
	"complete",
	taskId,
	"--run",
	"run_war",
	"--token",
	"1",
	...extra,
];

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
		await upsertRun(dbPath, "run_pandora", "pandora");
		const taskId = await enqueueGlobalTriage(
			dbPath,
			"run_pandora",
			"stdin task",
			"line 1\nline 2\n",
		);

		const inspect = await runCli(["task", "inspect", taskId], dbPath);
		const inspected = JSON.parse(inspect.stdout[0] ?? "") as {
			readonly ok: true;
			readonly dependencies: readonly unknown[];
			readonly task: { readonly title: string };
		};
		expect(inspected).toMatchObject({ ok: true, dependencies: [] });
		expect(inspected.task.title).toBe("stdin task");
		expect(taskBody(dbPath, taskId)).toBe("line 1\nline 2\n");
	});

	it("supersedes with explicit stdin replacement body", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await upsertRun(dbPath, "run_toil");
		const originalTaskId = await enqueueGlobalTriage(dbPath, "run_toil", "old task", "old body");

		const replacement = await runCli(
			[
				"task",
				"supersede",
				originalTaskId,
				"--reason",
				"replace body",
				"--title",
				"new task",
				"--stdin",
				"--run",
				"run_toil",
			],
			dbPath,
			{ _tag: "RedirectedText", text: "new body\n" },
		);
		const replacementTaskId = (JSON.parse(replacement.stdout[0] ?? "") as { task: { id: string } })
			.task.id;
		expect(taskBody(dbPath, replacementTaskId)).toBe("new body\n");
		expect(taskBody(dbPath, originalTaskId)).toBe("old body");
	});

	it("returns validation JSON when supersede omits --stdin", async () => {
		const result = await runCli(
			["task", "supersede", "task_missing", "--reason", "replace body"],
			tempDb(),
		);
		expect(JSON.parse(result.stderr[0] ?? "")).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_ERROR" },
		});
		expect(result.exitCode).toBe(2);
		expect(result.configRead).toBe(false);
	});

	it("validates supersede stdin availability and non-empty content", async () => {
		for (const stdin of [
			{ _tag: "NoRedirectedStdin" as const },
			{ _tag: "RedirectedText" as const, text: "" },
		]) {
			const result = await runCli(
				["task", "supersede", "task_missing", "--reason", "replace body", "--stdin"],
				tempDb(),
				stdin,
			);
			expect(JSON.parse(result.stderr[0] ?? "")).toMatchObject({
				ok: false,
				error: { code: "VALIDATION_ERROR" },
			});
			expect(result.exitCode).toBe(2);
			expect(result.configRead).toBe(false);
		}
	});

	it("returns parser errors for removed supersede body flags", async () => {
		for (const flag of ["--body", "--body-file"] as const) {
			await expect(
				runCli(
					["task", "supersede", "task_missing", "--reason", "replace body", flag, "payload"],
					tempDb(),
				),
			).rejects.toThrow(flag);
		}
	});

	it("adds artifact bodies from explicit stdin", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await upsertRun(dbPath, "run_toil");
		const taskId = await enqueueGlobalTriage(dbPath, "run_toil", "artifact task", "task body");

		const result = await runCli(artifactAddArgs(taskId, ["--stdin", "--run", "run_toil"]), dbPath, {
			_tag: "RedirectedText",
			text: "artifact body\n",
		});
		const artifactId = (JSON.parse(result.stdout[0] ?? "") as { artifact: { id: string } }).artifact
			.id;
		expect(artifactBody(dbPath, artifactId)).toBe("artifact body\n");
	});

	it("returns validation JSON when artifact add omits --stdin", async () => {
		const result = await runCli(artifactAddArgs(), tempDb());
		expect(JSON.parse(result.stderr[0] ?? "")).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_ERROR" },
		});
		expect(result.exitCode).toBe(2);
		expect(result.configRead).toBe(false);
	});

	it("validates artifact add stdin availability and non-empty content", async () => {
		for (const stdin of [
			{ _tag: "NoRedirectedStdin" as const },
			{ _tag: "RedirectedText" as const, text: "" },
		]) {
			const result = await runCli(artifactAddArgs("task_missing", ["--stdin"]), tempDb(), stdin);
			expect(JSON.parse(result.stderr[0] ?? "")).toMatchObject({
				ok: false,
				error: { code: "VALIDATION_ERROR" },
			});
			expect(result.exitCode).toBe(2);
			expect(result.configRead).toBe(false);
		}
	});

	it("surfaces artifact add stdin read failures as tagged JSON", async () => {
		const result = await runCli(artifactAddArgs("task_missing", ["--stdin"]), tempDb(), {
			_tag: "ReadFailure",
			error: new PithosError({ code: "USER_ERROR", message: "stdin exploded" }),
		});
		expect(JSON.parse(result.stderr[0] ?? "")).toEqual({
			ok: false,
			error: { code: "USER_ERROR", message: "stdin exploded" },
		});
	});

	it("returns parser errors for removed artifact add body-file flag", async () => {
		await expect(
			runCli(artifactAddArgs("task_missing", ["--body-file", "payload.txt"]), tempDb()),
		).rejects.toThrow("--body-file");
	});

	it("completes with default result metadata without reading stdin", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await runCli(["scope", "upsert", "--kind", "repo", "--path", "/tmp/pithos-cli"], dbPath);
		await upsertRun(dbPath, "run_toil");
		await upsertRepoWarRun(dbPath);
		const taskId = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"repo:/tmp/pithos-cli",
				"--capability",
				"execute",
				"--title",
				"complete task",
				"--stdin",
				"--run",
				"run_toil",
			],
			dbPath,
			{ _tag: "RedirectedText", text: "body" },
		).then((r) => (JSON.parse(r.stdout[0] ?? "") as { task: { id: string } }).task.id);
		await runCli(
			[
				"task",
				"claim",
				"--run",
				"run_war",
				"--scope",
				"repo:/tmp/pithos-cli",
				"--capability",
				"execute",
			],
			dbPath,
		);

		const result = await runCli(completeArgs(taskId), dbPath, {
			_tag: "ReadFailure",
			error: new PithosError({ code: "USER_ERROR", message: "stdin should not be read" }),
		});

		expect(JSON.parse(result.stdout[0] ?? "")).toEqual({
			ok: true,
			task: { id: taskId, status: "done" },
		});
		expect(result.stdinReads()).toBe(0);
		expect(taskResultJson(dbPath, taskId)).toBe("{}");
	});

	it("completes with JSON object result metadata from explicit stdin", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await runCli(["scope", "upsert", "--kind", "repo", "--path", "/tmp/pithos-cli"], dbPath);
		await upsertRun(dbPath, "run_toil");
		await upsertRepoWarRun(dbPath);
		const taskId = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"repo:/tmp/pithos-cli",
				"--capability",
				"execute",
				"--title",
				"metadata task",
				"--stdin",
				"--run",
				"run_toil",
			],
			dbPath,
			{ _tag: "RedirectedText", text: "body" },
		).then((r) => (JSON.parse(r.stdout[0] ?? "") as { task: { id: string } }).task.id);
		await runCli(
			[
				"task",
				"claim",
				"--run",
				"run_war",
				"--scope",
				"repo:/tmp/pithos-cli",
				"--capability",
				"execute",
			],
			dbPath,
		);

		const result = await runCli(completeArgs(taskId, ["--stdin"]), dbPath, {
			_tag: "RedirectedText",
			text: '{"ok":true}',
		});

		expect(result.stdinReads()).toBe(1);
		expect(taskResultJson(dbPath, taskId)).toBe('{"ok":true}');
	});

	it("validates complete stdin availability, empty content, invalid JSON, and non-object JSON", async () => {
		for (const stdin of [
			{ _tag: "NoRedirectedStdin" as const },
			{ _tag: "RedirectedText" as const, text: "" },
			{ _tag: "RedirectedText" as const, text: "not json" },
			{ _tag: "RedirectedText" as const, text: "[]" },
			{ _tag: "RedirectedText" as const, text: '"text"' },
			{ _tag: "RedirectedText" as const, text: "1" },
			{ _tag: "RedirectedText" as const, text: "true" },
			{ _tag: "RedirectedText" as const, text: "null" },
		]) {
			const result = await runCli(completeArgs("task_missing", ["--stdin"]), tempDb(), stdin);
			expect(JSON.parse(result.stderr[0] ?? "")).toMatchObject({
				ok: false,
				error: { code: "VALIDATION_ERROR" },
			});
			expect(result.exitCode).toBe(2);
			expect(result.configRead).toBe(false);
		}
	});

	it("returns parser errors for removed complete result-file flag", async () => {
		await expect(
			runCli(completeArgs("task_missing", ["--result-file", "result.json"]), tempDb()),
		).rejects.toThrow("--result-file");
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
