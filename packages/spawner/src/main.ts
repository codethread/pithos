import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { CliConfig, Command } from "@effect/cli";
import * as ValidationError from "@effect/cli/ValidationError";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, ParseResult, Schema } from "effect";
import {
	type CliHandlers,
	type NudgeCliInput,
	type SpawnCliInput,
	type StatusCliInput,
	type TargetCliInput,
	NudgeCliInputSchema,
	SpawnInvocationSchema,
	StatusCliInputSchema,
	TargetCliInputSchema,
	makePandoraSpawnCommand,
} from "./cli.ts";
import { HarnessService, HarnessServiceLive, tmuxSessionName } from "./harness.ts";
import { agentsPath, templatesDir } from "./paths.ts";
import { loadAgentManifests, loadTemplate, render } from "./template.ts";
import { tmuxNudgeCommands } from "./tmux.ts";
import { SpawnerError, exitCodeFor } from "./errors.ts";
import type { ErrorCode } from "./errors.ts";

interface ExecFailure {
	readonly stderr?: Buffer | string;
}

const RunRegisterOutputSchema = Schema.parseJson(
	Schema.Struct({
		run: Schema.Struct({
			id: Schema.NonEmptyString,
		}),
	}),
);

const writeJson = (value: unknown): void => {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const writeError = (code: ErrorCode, message: string): void => {
	process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
};

const decode = <A, I>(
	schema: Schema.Schema<A, I>,
	value: unknown,
	code: ErrorCode,
	message: string,
): Effect.Effect<A, SpawnerError> =>
	Schema.decodeUnknown(schema)(value).pipe(
		Effect.mapError(
			(error) =>
				new SpawnerError({
					code,
					message: `${message}\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
				}),
		),
	);

const commandFailure = (args: readonly string[], error: unknown): SpawnerError => {
	const failure = error as ExecFailure;
	if (typeof failure.stderr === "string" && failure.stderr.length > 0) {
		process.stderr.write(failure.stderr);
	} else if (Buffer.isBuffer(failure.stderr) && failure.stderr.length > 0) {
		process.stderr.write(failure.stderr);
	}
	return new SpawnerError({
		code: "UPSTREAM_ERROR",
		message: `${args.join(" ")} failed`,
	});
};

const pithos = (args: readonly string[], env: NodeJS.ProcessEnv = process.env): string => {
	const cmd = ["pithos", ...args] as const;
	try {
		return execFileSync(cmd[0], cmd.slice(1), { env }).toString();
	} catch (error: unknown) {
		throw commandFailure(cmd, error);
	}
};

const execText = (args: readonly string[]): string => {
	const executable = args[0];
	if (executable === undefined) {
		throw new SpawnerError({
			code: "UPSTREAM_ERROR",
			message: "missing executable",
		});
	}
	try {
		return execFileSync(executable, args.slice(1)).toString();
	} catch (error: unknown) {
		throw commandFailure(args, error);
	}
};

const parseRunId = (raw: string): Effect.Effect<string, SpawnerError> =>
	decode(
		RunRegisterOutputSchema,
		raw,
		"UPSTREAM_ERROR",
		"pithos run register returned invalid JSON",
	).pipe(Effect.map(({ run }) => run.id));

const spawn = (raw: SpawnCliInput) =>
	Effect.gen(function* () {
		const opts = yield* decode(
			SpawnInvocationSchema,
			{
				agent: raw.agent,
				scope: raw.scope,
				cwd: raw.cwd,
				...(raw.harness !== undefined ? { harness: raw.harness } : {}),
				preview: raw.preview,
				...(raw.task !== undefined ? { task: raw.task } : {}),
				...(raw.message !== undefined ? { message: raw.message } : {}),
			},
			"VALIDATION_ERROR",
			"invalid spawn invocation",
		);
		const template = loadTemplate(agentsPath, templatesDir, opts.agent);
		const agentCwd = template.manifest.cwd?.startsWith("~/")
			? `${homedir()}${template.manifest.cwd.slice(1)}`
			: template.manifest.cwd;
		const cwd = agentCwd ?? opts.cwd;
		const pithosHelp = process.env.PANDORA_SPAWN_FAKE_PITHOS_HELP ?? pithos(["--help"]);
		const sessionId =
			process.env.PANDORA_SPAWN_FAKE_SESSION_ID ??
			(opts.preview ? "session_PREVIEW" : randomUUID());
		const runId =
			process.env.PANDORA_SPAWN_FAKE_RUN_ID ??
			(opts.preview
				? "run_PREVIEW"
				: yield* parseRunId(
						pithos([
							"run",
							"register",
							"--agent-kind",
							opts.agent,
							"--scope",
							opts.scope,
							"--cwd",
							cwd,
							"--session-id",
							sessionId,
						]),
					));
		const launcherCommands = template.launcher?.commands;
		const launcherMeta =
			template.manifest.inject_meta && template.launcher !== undefined
				? `## Launcher meta\n\n\`\`\`json\n${JSON.stringify({ kind: template.launcher.kind, harness: template.launcher.harness, meta: template.launcher.meta }, null, 2)}\n\`\`\``
				: "";
		const harnessConfig = template.manifest.harness;
		const selectedHarness = opts.harness ?? harnessConfig.kind;
		if (selectedHarness !== "fake" && selectedHarness !== harnessConfig.kind) {
			throw new SpawnerError({
				code: "VALIDATION_ERROR",
				message: `${opts.agent} defines ${harnessConfig.kind} harness config, but ${selectedHarness} was requested`,
			});
		}
		const context = {
			agent: opts.agent,
			capability: template.manifest.capability,
			model: harnessConfig.model,
			tools_csv: harnessConfig.tools.join(","),
			run_id: runId,
			session_id: sessionId,
			scope_id: opts.scope,
			task_id: opts.task ?? "",
			cwd,
			pithos_help: pithosHelp,
			cmd_spawn: launcherCommands?.spawn ?? "",
			cmd_status: launcherCommands?.status ?? "",
			cmd_nudge: launcherCommands?.nudge ?? "",
			cmd_kill: launcherCommands?.kill ?? "",
			cmd_tty_status: launcherCommands?.tty_status ?? "",
			launcher_meta: launcherMeta,
			session_target: tmuxSessionName(opts.agent, sessionId),
			...template.includes,
		};
		const prompt = render(template.body, context);
		const env = {
			PITHOS_RUN_ID: runId,
			PITHOS_AGENT: opts.agent,
			PITHOS_SCOPE_ID: opts.scope,
			PITHOS_SESSION_ID: sessionId,
			PITHOS_OUTPUT: "json",
			...(opts.task ? { PITHOS_TASK_ID: opts.task } : {}),
		};
		const kickoffMessage = opts.message ?? "begin";
		const harnessService = yield* HarnessService;
		const harness = harnessService.get(selectedHarness);
		const description = harness.describe(
			harnessConfig.kind === "claude"
				? {
						kind: "claude",
						sessionId,
						model: harnessConfig.model,
						tools: harnessConfig.tools,
						systemPromptMode: harnessConfig.system_prompt_mode,
						prompt,
						cwd,
						env,
						...(kickoffMessage !== undefined ? { kickoffMessage } : {}),
					}
				: {
						kind: "pi",
						sessionId,
						model: harnessConfig.model,
						tools: harnessConfig.tools,
						systemPromptMode: harnessConfig.system_prompt_mode,
						prompt,
						cwd,
						env,
						...(kickoffMessage !== undefined ? { kickoffMessage } : {}),
					},
		);
		if (opts.preview) {
			writeJson({
				ok: true,
				preview: true,
				agent: opts.agent,
				run_id: runId,
				session_id: sessionId,
				scope_id: opts.scope,
				task_id: opts.task ?? null,
				harness: selectedHarness,
				...description,
			});
			return;
		}
		let result;
		try {
			result = harness.run(description, { agent: opts.agent, sessionId });
		} catch (error: unknown) {
			if (process.env.PANDORA_SPAWN_FAKE_RUN_ID === undefined) {
				try {
					pithos([
						"run",
						"end",
						"--run",
						runId,
						"--status",
						"failed",
						"--summary",
						`pandora-spawn ${selectedHarness} harness launch failed`,
					]);
				} catch {
					// surface original harness failure
				}
			}
			if (error instanceof SpawnerError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new SpawnerError({ code: "UPSTREAM_ERROR", message });
		}
		writeJson({
			ok: result.exitCode === 0,
			agent: opts.agent,
			run_id: runId,
			session_id: sessionId,
			scope_id: opts.scope,
			task_id: opts.task ?? null,
			harness: selectedHarness,
			pid: result.pid,
			...result.output,
		});
		process.exitCode = result.exitCode;
	});

const status = (raw: StatusCliInput) =>
	Effect.gen(function* () {
		const opts = yield* decode(
			StatusCliInputSchema,
			raw,
			"VALIDATION_ERROR",
			"invalid status invocation",
		);
		const harnessService = yield* HarnessService;
		process.stdout.write(`${harnessService.renderStatus(opts.sessionId, opts.lines)}\n`);
	});

const nudge = (raw: NudgeCliInput) =>
	Effect.gen(function* () {
		const opts = yield* decode(
			NudgeCliInputSchema,
			raw,
			"VALIDATION_ERROR",
			"invalid nudge invocation",
		);
		for (const command of tmuxNudgeCommands(opts.target, opts.message)) {
			execText(command);
		}
	});

const kill = (raw: TargetCliInput) =>
	Effect.gen(function* () {
		const opts = yield* decode(
			TargetCliInputSchema,
			raw,
			"VALIDATION_ERROR",
			"invalid kill invocation",
		);
		process.stdout.write(execText(["tmux", "kill-session", "-t", opts.target]));
	});

const ttyStatus = (raw: TargetCliInput) =>
	Effect.gen(function* () {
		const opts = yield* decode(
			TargetCliInputSchema,
			raw,
			"VALIDATION_ERROR",
			"invalid tty-status invocation",
		);
		process.stdout.write(execText(["tmux", "capture-pane", "-t", opts.target, "-p"]));
	});

const templatesList = () =>
	Effect.sync(() => {
		const templates = loadAgentManifests(agentsPath).map((manifest) => ({
			name: manifest.agent,
			harness: manifest.harness,
			capability: manifest.capability,
			cwd: manifest.cwd ?? null,
			launcher: manifest.launcher ?? null,
		}));
		writeJson({ ok: true, templates });
	});

const handlers: CliHandlers = {
	spawn,
	status,
	nudge,
	kill,
	ttyStatus,
	templatesList,
};

const cli = Command.run(makePandoraSpawnCommand(handlers), {
	name: "Pithos Spawner",
	version: "0.1.0",
	executable: "pandora-spawn",
});

const program = cli(process.argv).pipe(
	Effect.catchTag("SpawnerError", (error) =>
		Effect.sync(() => {
			writeError(error.code, error.message);
			process.exit(exitCodeFor(error.code));
		}),
	),
	Effect.catchAll((error: unknown) =>
		ValidationError.isValidationError(error)
			? Effect.sync(() => process.exit(2))
			: Effect.sync(() => {
					const message = error instanceof Error ? error.message : String(error);
					writeError("UPSTREAM_ERROR", message);
					process.exit(1);
				}),
	),
	Effect.provide(
		Layer.mergeAll(NodeContext.layer, CliConfig.layer({ showBuiltIns: true }), HarnessServiceLive),
	),
);

NodeRuntime.runMain(program);
