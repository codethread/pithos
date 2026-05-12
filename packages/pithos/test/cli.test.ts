import Database from "better-sqlite3";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PithosError, runPithosCli, type PithosHelpCommand, type Services } from "../src/index.js";

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
			existsDirectory: () => Effect.succeed(true),
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
	await Effect.runPromise(
		runPithosCli(
			{
				config: () => {
					configRead = true;
					return { dbPath };
				},
				services: svc,
			},
			["node", "pithos", ...args],
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

const taskDependencies = (dbPath: string, taskId: string): readonly string[] => {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id ASC",
			)
			.pluck()
			.all(taskId) as string[];
	} finally {
		db.close();
	}
};

const taskCreatedPayload = (dbPath: string, taskId: string) => {
	const db = new Database(dbPath, { readonly: true });
	try {
		return JSON.parse(
			db
				.prepare("SELECT payload_json FROM events WHERE type = 'task.created' AND task_id = ?")
				.pluck()
				.get(taskId) as string,
		) as unknown;
	} finally {
		db.close();
	}
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

const normalizeGeneratedIds = (text: string): string =>
	text.replaceAll(/task_cli_\d+/g, "task_cli_N").replaceAll(/artifact_cli_\d+/g, "artifact_cli_N");

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
		const listed = await runCli(["scope", "list"], dbPath);
		expect(JSON.parse(listed.stdout[0] ?? "")).toEqual({
			ok: true,
			scopes: [
				{
					id: "global",
					kind: "global",
					canonical_path: null,
					archived_at: null,
					task_count: 0,
					run_count: 0,
				},
				{
					id: "repo:/tmp/pithos-cli",
					kind: "repo",
					canonical_path: "/tmp/pithos-cli",
					archived_at: null,
					task_count: 0,
					run_count: 0,
				},
			],
		});

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

	it("archives unreferenced scopes by deleting them through the CLI", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await runCli(["scope", "upsert", "--kind", "repo", "--path", "/tmp/pithos-delete-cli"], dbPath);
		const archived = await runCli(["scope", "archive", "repo:/tmp/pithos-delete-cli"], dbPath);
		expect(JSON.parse(archived.stdout[0] ?? "")).toEqual({
			ok: true,
			action: "deleted",
			scope: {
				id: "repo:/tmp/pithos-delete-cli",
				kind: "repo",
				canonical_path: "/tmp/pithos-delete-cli",
				archived_at: null,
				task_count: 0,
				run_count: 0,
			},
		});
		const listed = await runCli(["scope", "list"], dbPath);
		expect(JSON.parse(listed.stdout[0] ?? "")).toEqual({
			ok: true,
			scopes: [
				{
					id: "global",
					kind: "global",
					canonical_path: null,
					archived_at: null,
					task_count: 0,
					run_count: 0,
				},
			],
		});
	});

	it("lists archived scopes only with --all through the CLI", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await upsertRun(dbPath, "run_toil");
		await runCli(
			["scope", "upsert", "--kind", "repo", "--path", "/tmp/pithos-archive-cli"],
			dbPath,
		);
		const taskId = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"repo:/tmp/pithos-archive-cli",
				"--capability",
				"execute",
				"--title",
				"archive me",
				"--stdin",
				"--run",
				"run_toil",
			],
			dbPath,
			{ _tag: "RedirectedText", text: "body" },
		).then((result) => (JSON.parse(result.stdout[0] ?? "") as { task: { id: string } }).task.id);
		await runCli(["task", "cancel", taskId, "--run", "run_toil", "--reason", "done"], dbPath);
		const archived = await runCli(["scope", "archive", "repo:/tmp/pithos-archive-cli"], dbPath);
		const archivedBody = JSON.parse(archived.stdout[0] ?? "") as {
			ok: true;
			action: string;
			scope: { id: string; archived_at: string | null };
		};
		expect(archivedBody.ok).toBe(true);
		expect(archivedBody.action).toBe("archived");
		expect(archivedBody.scope.id).toBe("repo:/tmp/pithos-archive-cli");
		expect(archivedBody.scope.archived_at).toEqual(expect.any(String));
		const activeOnly = await runCli(["scope", "list"], dbPath);
		expect(
			(JSON.parse(activeOnly.stdout[0] ?? "") as { scopes: { id: string }[] }).scopes.map(
				(scope) => scope.id,
			),
		).toEqual(["global"]);
		const allScopes = await runCli(["scope", "list", "--all"], dbPath);
		const archivedScope = (
			JSON.parse(allScopes.stdout[0] ?? "") as {
				scopes: { id: string; archived_at: string | null }[];
			}
		).scopes.find((scope) => scope.id === "repo:/tmp/pithos-archive-cli");
		expect(archivedScope).toBeDefined();
		expect(archivedScope?.archived_at).toEqual(expect.any(String));
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

		const inspect = await runCli(["task", "inspect", taskId, "--json"], dbPath);
		const inspected = JSON.parse(inspect.stdout[0] ?? "") as {
			readonly ok: true;
			readonly dependencies: readonly unknown[];
			readonly lineage: readonly unknown[];
			readonly task: { readonly title: string; readonly body: string };
		};
		expect(inspected).toMatchObject({ ok: true, dependencies: [], lineage: [] });
		expect(inspected.task.title).toBe("stdin task");
		expect(inspected.task.body).toBe("line 1\nline 2\n");
		expect(taskBody(dbPath, taskId)).toBe("line 1\nline 2\n");
	});

	it("renders task inspect as a markdown handoff with nested history and artifacts by default", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await upsertRun(dbPath, "run_toil");
		const origin = await enqueueGlobalTriage(dbPath, "run_toil", "Original request", "origin body");
		const ancestor = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"Ancestor decision",
				"--stdin",
				"--run",
				"run_toil",
				"--chain",
				"none",
				"--depends-on",
				origin,
			],
			dbPath,
			{ _tag: "RedirectedText", text: "ancestor body" },
		).then((result) => (JSON.parse(result.stdout[0] ?? "") as { task: { id: string } }).task.id);
		await runCli(artifactAddArgs(ancestor, ["--stdin", "--run", "run_toil"]), dbPath, {
			_tag: "RedirectedText",
			text: "ancestor artifact",
		});
		const parent = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"Parent plan",
				"--stdin",
				"--run",
				"run_toil",
				"--chain",
				"none",
				"--depends-on",
				ancestor,
			],
			dbPath,
			{ _tag: "RedirectedText", text: "parent body" },
		).then((result) => (JSON.parse(result.stdout[0] ?? "") as { task: { id: string } }).task.id);
		await runCli(artifactAddArgs(parent, ["--stdin", "--run", "run_toil"]), dbPath, {
			_tag: "RedirectedText",
			text: "parent artifact",
		});
		const current = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"Current handoff",
				"--stdin",
				"--run",
				"run_toil",
				"--chain",
				"none",
				"--depends-on",
				parent,
			],
			dbPath,
			{ _tag: "RedirectedText", text: "current body" },
		).then((result) => (JSON.parse(result.stdout[0] ?? "") as { task: { id: string } }).task.id);
		await runCli(artifactAddArgs(current, ["--stdin", "--run", "run_toil"]), dbPath, {
			_tag: "RedirectedText",
			text: "current artifact",
		});
		await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"Dependent follow-up",
				"--stdin",
				"--run",
				"run_toil",
				"--chain",
				"none",
				"--depends-on",
				current,
			],
			dbPath,
			{ _tag: "RedirectedText", text: "dependent body" },
		);

		const inspect = await runCli(["task", "inspect", current], dbPath);
		const output = inspect.stdout[0] ?? "";

		expect(output.startsWith(`# ${current} [triage] [blocked] Current handoff\n`)).toBe(true);
		expect(() => {
			JSON.parse(output) as unknown;
		}).toThrow();
		expect(output).not.toContain(`### ${origin} [triage] [queued] Original request`);
		expect(normalizeGeneratedIds(output)).toMatchInlineSnapshot(`
			"# task_cli_N [triage] [blocked] Current handoff

			## Recent history

			### task_cli_N [triage] [blocked] Ancestor decision

			Body:

			\`\`\`md
			ancestor body
			\`\`\`

			Artifact artifact_cli_N [note] evidence:

			\`\`\`md
			ancestor artifact
			\`\`\`

			### task_cli_N [triage] [blocked] Parent plan

			Body:

			\`\`\`md
			parent body
			\`\`\`

			Artifact artifact_cli_N [note] evidence:

			\`\`\`md
			parent artifact
			\`\`\`

			## Current task

			### task_cli_N [triage] [blocked] Current handoff

			Body:

			\`\`\`md
			current body
			\`\`\`

			Artifact artifact_cli_N [note] evidence:

			\`\`\`md
			current artifact
			\`\`\`

			Depends on:

			- task_cli_N [triage] [blocked] Parent plan

			Unlocks:

			- task_cli_N [triage] [blocked] Dependent follow-up
			"
		`);
	});

	it("snapshots task inspect markdown for a deep chain window", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await upsertRun(dbPath, "run_toil");
		const origin = await enqueueGlobalTriage(dbPath, "run_toil", "Original request", "origin body");
		const triage = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"Triage plan",
				"--stdin",
				"--run",
				"run_toil",
				"--chain",
				"none",
				"--depends-on",
				origin,
			],
			dbPath,
			{ _tag: "RedirectedText", text: "triage body" },
		).then((result) => (JSON.parse(result.stdout[0] ?? "") as { task: { id: string } }).task.id);
		const design = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"Design output mode",
				"--stdin",
				"--run",
				"run_toil",
				"--chain",
				"none",
				"--depends-on",
				triage,
			],
			dbPath,
			{ _tag: "RedirectedText", text: "design body" },
		).then((result) => (JSON.parse(result.stdout[0] ?? "") as { task: { id: string } }).task.id);
		await runCli(artifactAddArgs(design, ["--stdin", "--run", "run_toil"]), dbPath, {
			_tag: "RedirectedText",
			text: "## Design artifact\n\nUse Markdown defaults and --json for machines.",
		});
		const execute = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"Execute renderer",
				"--stdin",
				"--run",
				"run_toil",
				"--chain",
				"none",
				"--depends-on",
				design,
			],
			dbPath,
			{ _tag: "RedirectedText", text: "execute body" },
		).then((result) => (JSON.parse(result.stdout[0] ?? "") as { task: { id: string } }).task.id);
		await runCli(artifactAddArgs(execute, ["--stdin", "--run", "run_toil"]), dbPath, {
			_tag: "RedirectedText",
			text: "execution evidence",
		});
		const followUp = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"Follow-up verification",
				"--stdin",
				"--run",
				"run_toil",
				"--chain",
				"none",
				"--depends-on",
				execute,
			],
			dbPath,
			{ _tag: "RedirectedText", text: "follow-up body" },
		).then((result) => (JSON.parse(result.stdout[0] ?? "") as { task: { id: string } }).task.id);

		const inspect = await runCli(["task", "inspect", followUp], dbPath);
		expect(inspect.stdout[0]).not.toContain("Original request");
		expect(inspect.stdout[0]).not.toContain("Triage plan");
		expect(normalizeGeneratedIds(inspect.stdout[0] ?? "")).toMatchInlineSnapshot(`
			"# task_cli_N [triage] [blocked] Follow-up verification

			## Recent history

			### task_cli_N [triage] [blocked] Design output mode

			Body:

			\`\`\`md
			design body
			\`\`\`

			Artifact artifact_cli_N [note] evidence:

			\`\`\`md
			## Design artifact

			Use Markdown defaults and --json for machines.
			\`\`\`

			### task_cli_N [triage] [blocked] Execute renderer

			Body:

			\`\`\`md
			execute body
			\`\`\`

			Artifact artifact_cli_N [note] evidence:

			\`\`\`md
			execution evidence
			\`\`\`

			## Current task

			### task_cli_N [triage] [blocked] Follow-up verification

			Body:

			\`\`\`md
			follow-up body
			\`\`\`

			Depends on:

			- task_cli_N [triage] [blocked] Execute renderer

			Unlocks:

			- none
			"
		`);
	});

	it("snapshots readable graph inspect for a nested forked chain", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await runCli(["scope", "upsert", "--kind", "repo", "--path", "/tmp/pithos-cli"], dbPath);
		await runCli(
			[
				"run",
				"upsert",
				"--agent",
				"toil",
				"--mode",
				"afk",
				"--scope",
				"repo:/tmp/pithos-cli",
				"--cwd",
				"/tmp/pithos-cli",
				"--session-id",
				"session_run_toil_repo",
				"--harness-kind",
				"pi",
				"--session-log-path",
				"/tmp/session_run_toil_repo.jsonl",
				"--run",
				"run_toil_repo",
			],
			dbPath,
		);
		const enqueue = async (
			title: string,
			capability: "triage" | "design" | "execute",
			dependsOn: readonly string[] = [],
		): Promise<string> =>
			runCli(
				[
					"task",
					"enqueue",
					"--scope",
					"repo:/tmp/pithos-cli",
					"--capability",
					capability,
					"--title",
					title,
					"--stdin",
					"--run",
					"run_toil_repo",
					"--chain",
					"none",
					...dependsOn.flatMap((id) => ["--depends-on", id]),
				],
				dbPath,
				{ _tag: "RedirectedText", text: `${title} body` },
			).then((result) => (JSON.parse(result.stdout[0] ?? "") as { task: { id: string } }).task.id);

		const triage = await enqueue("Triage readable inspect API", "triage");
		const design = await enqueue("Design output mode contract", "design", [triage]);
		const executeA = await enqueue("Execute A task inspect renderer", "execute", [design]);
		const executeB = await enqueue("Execute B graph briefing help", "execute", [design]);
		await enqueue("Follow-up A docs for inspect", "execute", [executeA]);
		await enqueue("Follow-up B prompt verification", "execute", [executeB]);

		const graphText = await runCli(["graph", "inspect", "--scope", "repo:/tmp/pithos-cli"], dbPath);
		expect(normalizeGeneratedIds(graphText.stdout[0] ?? "")).toMatchInlineSnapshot(`
			"- task_cli_N [triage] [queued] Triage readable inspect API
			  - task_cli_N [design] [blocked] Design output mode contract
			    - task_cli_N [execute] [blocked] Execute A task inspect renderer
			      - task_cli_N [execute] [blocked] Follow-up A docs for inspect
			    - task_cli_N [execute] [blocked] Execute B graph briefing help
			      - task_cli_N [execute] [blocked] Follow-up B prompt verification
			"
		`);
	});

	it("renders graph inspect and briefing as readable text by default with --json escape hatch", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await upsertRun(dbPath, "run_toil");
		const ready = await enqueueGlobalTriage(dbPath, "run_toil", "Ready triage", "ready body");
		const blocked = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"Blocked triage",
				"--stdin",
				"--run",
				"run_toil",
				"--chain",
				"none",
				"--depends-on",
				ready,
			],
			dbPath,
			{ _tag: "RedirectedText", text: "blocked body" },
		).then((result) => (JSON.parse(result.stdout[0] ?? "") as { task: { id: string } }).task.id);

		const graphText = await runCli(["graph", "inspect", "--all"], dbPath);
		expect(() => {
			JSON.parse(graphText.stdout[0] ?? "") as unknown;
		}).toThrow();
		expect(normalizeGeneratedIds(graphText.stdout[0] ?? "")).toMatchInlineSnapshot(`
			"- task_cli_N [triage] [queued] Ready triage
			  - task_cli_N [triage] [blocked] Blocked triage
			"
		`);

		const graphJson = await runCli(["graph", "inspect", "--all", "--json"], dbPath);
		expect(JSON.parse(graphJson.stdout[0] ?? "")).toMatchObject({
			ok: true,
			graph: {
				selector: { kind: "all" },
				nodes: [expect.objectContaining({ id: ready }), expect.objectContaining({ id: blocked })],
			},
		});

		const briefingText = await runCli(["briefing", "--agent", "toil"], dbPath);
		expect(normalizeGeneratedIds(briefingText.stdout[0] ?? "")).toMatchInlineSnapshot(`
			"# Briefing

			## Ready
			- task_cli_N [triage] [queued] Ready triage

			## Blocked
			- task_cli_N [triage] [blocked] Blocked triage
			  - blocked by task_cli_N [queued] scope=global
			"
		`);

		const briefingJson = await runCli(["briefing", "--agent", "toil", "--json"], dbPath);
		expect(JSON.parse(briefingJson.stdout[0] ?? "")).toMatchObject({
			ok: true,
			ready: [expect.objectContaining({ id: ready })],
			blocked: [expect.objectContaining({ id: blocked, unresolved_dependency_ids: [ready] })],
		});
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

	it("returns parser errors for removed artifact add task flag", async () => {
		await expect(
			runCli(
				[
					"task",
					"artifact",
					"add",
					"task_missing",
					"--kind",
					"note",
					"--title",
					"evidence",
					"--stdin",
					"--task",
					"task_extra",
				],
				tempDb(),
			),
		).rejects.toThrow("--task");
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

	it("defaults enqueue chain to auto and returns deterministic chain metadata", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await upsertRun(dbPath, "run_toil");
		const result = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"default chain",
				"--stdin",
				"--run",
				"run_toil",
			],
			dbPath,
			{ _tag: "RedirectedText", text: "body" },
		);
		const output = JSON.parse(result.stdout[0] ?? "") as {
			readonly task: { readonly id: string };
			readonly chain: unknown;
		};
		expect(output.chain).toEqual({
			policy: "auto",
			applied: "flat_no_held_task",
			held_task_id: null,
			source_task_id: null,
			source_kind: null,
			implicit_dependency_ids: [],
			final_dependency_ids: [],
		});
		expect(taskCreatedPayload(dbPath, output.task.id)).toMatchObject({ chain: output.chain });
	});

	it("keeps --chain none manual-only with explicit dependencies", async () => {
		const dbPath = tempDb();
		await runCli(["init", "--fresh"], dbPath);
		await upsertRun(dbPath, "run_toil");
		const blocker = await enqueueGlobalTriage(dbPath, "run_toil", "manual blocker", "body");
		const result = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"design",
				"--title",
				"manual child",
				"--stdin",
				"--run",
				"run_toil",
				"--chain",
				"none",
				"--depends-on",
				blocker,
			],
			dbPath,
			{ _tag: "RedirectedText", text: "body" },
		);
		const output = JSON.parse(result.stdout[0] ?? "") as {
			readonly task: { readonly id: string };
			readonly chain: unknown;
		};
		expect(output.chain).toEqual({
			policy: "none",
			applied: "none_selected",
			held_task_id: null,
			source_task_id: null,
			source_kind: null,
			implicit_dependency_ids: [],
			final_dependency_ids: [blocker],
		});
		expect(taskDependencies(dbPath, output.task.id)).toEqual([blocker]);
	});

	it("returns validation JSON for invalid --chain values before loading config", async () => {
		const result = await runCli(
			[
				"task",
				"enqueue",
				"--scope",
				"global",
				"--capability",
				"triage",
				"--title",
				"bad chain",
				"--stdin",
				"--chain",
				"bogus",
			],
			tempDb(),
			{ _tag: "RedirectedText", text: "body" },
		);
		expect(JSON.parse(result.stderr[0] ?? "")).toEqual({
			ok: false,
			error: {
				code: "VALIDATION_ERROR",
				message: "Invalid --chain value: 'bogus'. Valid values: auto, none, held, source",
			},
		});
		expect(result.exitCode).toBe(2);
		expect(result.configRead).toBe(false);
	});

	it("accepts held and source modes and fails loudly without a held task", async () => {
		for (const chain of ["held", "source"] as const) {
			const dbPath = tempDb();
			await runCli(["init", "--fresh"], dbPath);
			await upsertRun(dbPath, "run_toil");
			const result = await runCli(
				[
					"task",
					"enqueue",
					"--scope",
					"global",
					"--capability",
					"triage",
					"--title",
					`${chain} chain`,
					"--stdin",
					"--run",
					"run_toil",
					"--chain",
					chain,
				],
				dbPath,
				{ _tag: "RedirectedText", text: "body" },
			);
			expect(JSON.parse(result.stderr[0] ?? "")).toEqual({
				ok: false,
				error: { code: "VALIDATION_ERROR", message: `--chain ${chain} requires a held task` },
			});
			expect(result.exitCode).toBe(2);
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

	it("renders top-level --help as human help without loading config", async () => {
		for (const flag of ["--help", "-h"] as const) {
			const result = await runCli([flag], tempDb());
			expect(result.configRead).toBe(false);
			expect(result.stderr).toEqual([]);
			expect(result.stdout).toEqual([]);
		}
	});

	it("renders top-level --help-json as stable JSON without loading config", async () => {
		const result = await runCli(["--help-json"], tempDb());
		expect(result.configRead).toBe(false);
		expect(result.stderr).toEqual([]);
		const help = JSON.parse(result.stdout[0] ?? "") as PithosHelpCommand;
		expect(help).toMatchObject({
			tool: "pithos",
			name: "pithos",
			path: "pithos",
			usage: "pithos <command>",
			description:
				"Durable state CLI for tasks, runs, claims, artifacts, events, and graph invariants.",
		});
		expect(help.subcommands.map((command) => command.path)).toEqual([
			"pithos init",
			"pithos scope",
			"pithos run",
			"pithos task",
			"pithos graph",
			"pithos events",
			"pithos briefing",
		]);
		expect(
			help.subcommands.find((command) => command.path === "pithos scope")?.subcommands,
		).toMatchObject([
			{ path: "pithos scope upsert" },
			{ path: "pithos scope list" },
			{ path: "pithos scope archive" },
		]);
		expect(
			help.subcommands.find((command) => command.path === "pithos run")?.subcommands?.length,
		).toBeGreaterThan(0);
	});

	it("rejects --help-json when combined with other arguments", async () => {
		const result = await runCli(["--help-json", "task"], tempDb());
		expect(result.configRead).toBe(false);
		expect(result.stdout).toEqual([]);
		expect(JSON.parse(result.stderr[0] ?? "")).toEqual({
			ok: false,
			error: {
				code: "VALIDATION_ERROR",
				message: "--help-json must be the only pithos argument",
			},
		});
		expect(result.exitCode).toBe(2);
	});

	it("renders artifact add and context format flags in help JSON", async () => {
		const result = await runCli(["--help-json"], tempDb());
		const help = JSON.parse(result.stdout[0] ?? "") as PithosHelpCommand;
		const flatten = (command: PithosHelpCommand): readonly PithosHelpCommand[] => [
			command,
			...command.subcommands.flatMap(flatten),
		];
		const commands = flatten(help);
		expect(commands.filter((command) => command.path === "pithos task artifact add")).toHaveLength(
			1,
		);
		expect(commands.some((command) => command.path === "pithos task task artifact add")).toBe(
			false,
		);
		expect(result.stdout.join("").match(/pithos task artifact add/g)).toHaveLength(1);
		expect(commands.find((command) => command.path === "pithos task inspect")?.usage).toContain(
			"--json",
		);
		expect(commands.find((command) => command.path === "pithos graph inspect")?.usage).toContain(
			"--json",
		);
		expect(commands.find((command) => command.path === "pithos briefing")?.usage).toContain(
			"--json",
		);
	});
});
