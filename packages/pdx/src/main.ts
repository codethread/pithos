import { Args, CliConfig, Command, CommandDescriptor, HelpDoc, Options, Usage } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import process from "node:process";
import { inspect } from "node:util";
import {
	closePdx,
	killPdx,
	logsShowPdx,
	openPdx,
	runDaemon,
	runShowPdx,
	runTranscriptPdx,
	statusPdx,
	taskShowPdx,
} from "./controller.js";
import { parsePdxConfig } from "./config.js";
import { PdxError } from "./errors.js";
import {
	ClockLive,
	FileSystemLive,
	IdsLive,
	makePithosClientLive,
	makeSpawnerLive,
	ProcessLive,
} from "./live.js";
import { makeSupervisorLog } from "./log.js";
import { makeNoopLifecycleReporter, makeStdoutLifecycleReporter } from "./lifecycle.js";
import {
	Clock,
	FileSystem,
	Ids,
	LifecycleReporter,
	makeRegistry,
	PithosClient,
	Process,
	Registry,
	Spawner,
	SupervisorLog,
	Tmux,
} from "./services.js";
import { makeTmux } from "./tmux.js";

interface RuntimeInput {
	readonly envHome: string | undefined;
	readonly daemonEntrypoint: string | undefined;
}

type CommandInput =
	| {
			readonly command: "open";
			readonly dataDir: string | undefined;
			readonly maxAfk: number;
			readonly intervalSeconds: number;
	  }
	| { readonly command: "close"; readonly dataDir: string | undefined }
	| { readonly command: "daemon.status"; readonly dataDir: string | undefined }
	| {
			readonly command: "run.kill";
			readonly dataDir: string | undefined;
			readonly runId: string;
			readonly reason: string;
	  }
	| {
			readonly command: "task.kill";
			readonly dataDir: string | undefined;
			readonly taskId: string;
			readonly reason: string;
	  }
	| {
			readonly command: "daemon.logs";
			readonly dataDir: string | undefined;
			readonly limit: number | undefined;
			readonly all: boolean;
			readonly since: string | undefined;
	  }
	| {
			readonly command: "run.transcript";
			readonly dataDir: string | undefined;
			readonly runId: string;
			readonly limit: number | undefined;
	  }
	| {
			readonly command: "run.show";
			readonly dataDir: string | undefined;
			readonly runId: string;
	  }
	| {
			readonly command: "task.show";
			readonly dataDir: string | undefined;
			readonly taskId: string;
	  }
	| {
			readonly command: "daemon.run";
			readonly dataDir: string | undefined;
			readonly maxAfk: number;
			readonly intervalSeconds: number;
	  };

const defaultIntervalSeconds = 5;
const defaultMaxAfk = 4;

const opt = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value);
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

const writePdxError = (code: PdxError["code"], message: string) => {
	process.stderr.write(json({ ok: false, error: { code, message } }));
	process.exitCode = 2;
};

const parsePositiveInt = (value: number, name: string): Effect.Effect<number, PdxError> => {
	if (!Number.isInteger(value) || value <= 0) {
		return Effect.fail(
			new PdxError({ code: "VALIDATION_ERROR", message: `${name} must be a positive integer` }),
		);
	}
	return Effect.succeed(value);
};

const captureRuntimeInput = Effect.sync<RuntimeInput>(() => ({
	envHome: process.env.HOME,
	daemonEntrypoint: process.argv[1],
}));

const baseLayer = Layer.mergeAll(
	Layer.succeed(Process, ProcessLive),
	Layer.succeed(FileSystem, FileSystemLive),
	Layer.succeed(Clock, ClockLive),
	Layer.succeed(Ids, IdsLive),
);

const runCommand = (runtime: RuntimeInput, input: CommandInput) =>
	Effect.gen(function* () {
		const config = yield* parsePdxConfig({
			dataDir: input.dataDir,
			envHome: runtime.envHome,
			daemonEntrypoint: runtime.daemonEntrypoint,
		});
		const tmux = yield* makeTmux;
		const supervisorLog = yield* makeSupervisorLog(config.logPath);
		const registry = yield* makeRegistry;
		const clock = yield* Clock;
		const lifecycleReporter =
			input.command === "daemon.run"
				? makeStdoutLifecycleReporter(clock)
				: makeNoopLifecycleReporter();
		const provided = Layer.mergeAll(
			Layer.succeed(Tmux, tmux),
			Layer.succeed(SupervisorLog, supervisorLog),
			Layer.succeed(LifecycleReporter, lifecycleReporter),
			Layer.succeed(Registry, registry),
			Layer.succeed(PithosClient, makePithosClientLive(config.pithosDbPath)),
			Layer.succeed(Spawner, makeSpawnerLive(config)),
		);

		switch (input.command) {
			case "open":
				yield* openPdx(config, input.maxAfk, input.intervalSeconds).pipe(Effect.provide(provided));
				yield* Effect.sync(() => process.stdout.write("tmux attach -t pdx--pandora\n"));
				return;
			case "close":
				return yield* closePdx(config).pipe(Effect.provide(provided));
			case "daemon.status": {
				const status = yield* statusPdx(config, defaultMaxAfk).pipe(Effect.provide(provided));
				yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(status)}\n`));
				return;
			}
			case "run.kill":
				return yield* killPdx(config, {
					runId: input.runId,
					taskId: undefined,
					reason: input.reason,
				}).pipe(Effect.provide(provided));
			case "task.kill":
				return yield* killPdx(config, {
					runId: undefined,
					taskId: input.taskId,
					reason: input.reason,
				}).pipe(Effect.provide(provided));
			case "daemon.logs": {
				const outputText = yield* logsShowPdx(config, {
					limit: input.limit,
					all: input.all,
					since: input.since,
				}).pipe(Effect.provide(provided));
				yield* Effect.sync(() => process.stdout.write(outputText));
				return;
			}
			case "run.transcript": {
				const transcript = yield* runTranscriptPdx({
					runId: input.runId,
					limit: input.limit,
				}).pipe(Effect.provide(provided));
				yield* Effect.sync(() => process.stdout.write(transcript));
				return;
			}
			case "run.show": {
				const confirmation = yield* runShowPdx(config, { runId: input.runId }).pipe(
					Effect.provide(provided),
				);
				yield* Effect.sync(() => process.stdout.write(json(confirmation)));
				return;
			}
			case "task.show": {
				const confirmation = yield* taskShowPdx(config, { taskId: input.taskId }).pipe(
					Effect.provide(provided),
				);
				yield* Effect.sync(() => process.stdout.write(json(confirmation)));
				return;
			}
			case "daemon.run": {
				const handle = yield* runDaemon(config, input.maxAfk, input.intervalSeconds).pipe(
					Effect.provide(provided),
				);
				yield* handle.shutdown;
				yield* handle.close;
				return;
			}
		}
	}).pipe(Effect.provide(baseLayer));

const handleError = (error: unknown): Effect.Effect<void, unknown> => {
	if (error instanceof PdxError) {
		return Effect.sync(() => writePdxError(error.code, error.message));
	}
	return Effect.fail(error);
};

const parseInternalDaemonRun = (
	argv: readonly string[],
): Effect.Effect<CommandInput | undefined, PdxError> =>
	Effect.gen(function* () {
		if (argv[2] !== "daemon" || argv[3] !== "run") return undefined;
		let dataDir: string | undefined;
		let maxAfk = defaultMaxAfk;
		let intervalSeconds = defaultIntervalSeconds;
		for (let index = 4; index < argv.length; index++) {
			const arg = argv[index]!;
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				yield* Effect.fail(
					new PdxError({ code: "VALIDATION_ERROR", message: `${arg} requires a value` }),
				);
			}
			if (arg === "--data-dir") dataDir = value;
			else if (arg === "--max-afk") maxAfk = yield* parsePositiveInt(Number(value), "--max-afk");
			else if (arg === "--interval-seconds") {
				intervalSeconds = yield* parsePositiveInt(Number(value), "--interval-seconds");
			} else {
				yield* Effect.fail(
					new PdxError({ code: "VALIDATION_ERROR", message: `Unknown option: ${arg}` }),
				);
			}
			index += 1;
		}
		return { command: "daemon.run", dataDir, maxAfk, intervalSeconds } as const;
	});

interface JsonCommandHelp {
	readonly tool: string;
	readonly name: string;
	readonly command: string;
	readonly path: string;
	readonly fullPath: string;
	readonly pathSegments: readonly string[];
	readonly usage: string;
	readonly description: string;
	readonly subcommands: readonly JsonCommandHelp[];
}

const descriptorName = (descriptor: CommandDescriptor.Command<unknown>): string => {
	const node = descriptor as unknown as
		| { readonly _tag: "Standard" | "GetUserInput"; readonly name: string }
		| { readonly _tag: "Map"; readonly command: CommandDescriptor.Command<unknown> }
		| { readonly _tag: "Subcommands"; readonly parent: CommandDescriptor.Command<unknown> };
	switch (node._tag) {
		case "Standard":
		case "GetUserInput":
			return node.name;
		case "Map":
			return descriptorName(node.command);
		case "Subcommands":
			return descriptorName(node.parent);
	}
};

const descriptorDescription = (descriptor: CommandDescriptor.Command<unknown>): string => {
	const node = descriptor as unknown as
		| {
				readonly _tag: "Standard" | "GetUserInput";
				readonly description: HelpDoc.HelpDoc;
		  }
		| { readonly _tag: "Map"; readonly command: CommandDescriptor.Command<unknown> }
		| { readonly _tag: "Subcommands"; readonly parent: CommandDescriptor.Command<unknown> };
	switch (node._tag) {
		case "Standard":
		case "GetUserInput":
			return HelpDoc.toAnsiText(node.description).trim();
		case "Map":
			return descriptorDescription(node.command);
		case "Subcommands":
			return descriptorDescription(node.parent);
	}
};

const descriptorUsage = (
	descriptor: CommandDescriptor.Command<unknown>,
	path: readonly string[],
): string => {
	const ownUsage = HelpDoc.toAnsiText(Usage.getHelp(CommandDescriptor.getUsage(descriptor))).trim();
	const command = path.at(-1);
	const suffix =
		command === undefined || ownUsage === "" || ownUsage === command
			? ""
			: ownUsage.startsWith(`${command} `)
				? ownUsage.slice(command.length + 1)
				: ownUsage;
	return suffix === "" ? path.join(" ") : `${path.join(" ")} ${suffix}`;
};

const descriptorChildren = (
	descriptor: CommandDescriptor.Command<unknown>,
): readonly CommandDescriptor.Command<unknown>[] => {
	const node = descriptor as unknown as
		| { readonly _tag: "Standard" | "GetUserInput" }
		| { readonly _tag: "Map"; readonly command: CommandDescriptor.Command<unknown> }
		| {
				readonly _tag: "Subcommands";
				readonly children: readonly CommandDescriptor.Command<unknown>[];
		  };
	switch (node._tag) {
		case "Standard":
		case "GetUserInput":
			return [];
		case "Map":
			return descriptorChildren(node.command);
		case "Subcommands":
			return node.children;
	}
};

const commandHelpJson = (
	descriptor: CommandDescriptor.Command<unknown>,
	parentPath: readonly string[],
): JsonCommandHelp => {
	const command = descriptorName(descriptor);
	const path = [...parentPath, command];
	const subcommands = descriptorChildren(descriptor)
		.map((child) => commandHelpJson(child, path))
		.sort((left, right) => left.fullPath.localeCompare(right.fullPath));
	const fullPath = path.join(" ");
	return {
		tool: "pdx",
		name: command,
		command,
		path: fullPath,
		fullPath,
		pathSegments: path,
		usage: descriptorUsage(descriptor, path),
		description: descriptorDescription(descriptor),
		subcommands,
	};
};

const renderHelpJson = <Name extends string, R, E, A>(command: Command.Command<Name, R, E, A>) =>
	`${JSON.stringify(commandHelpJson(command.descriptor, []), null, 2)}\n`;

const handleHelpJson = <Name extends string, R, E, A>(
	argv: readonly string[],
	command: Command.Command<Name, R, E, A>,
): Effect.Effect<boolean, PdxError> => {
	const args = argv.slice(2);
	if (!args.includes("--help-json")) return Effect.succeed(false);
	if (args.length !== 1) {
		return Effect.fail(
			new PdxError({
				code: "VALIDATION_ERROR",
				message: "--help-json must be the only pdx argument",
			}),
		);
	}
	return Effect.sync(() => {
		process.stdout.write(renderHelpJson(command));
		return true;
	});
};

const makeCommand = (runtime: RuntimeInput) => {
	const open = Command.make(
		"open",
		{
			dataDir: Options.text("data-dir").pipe(
				Options.withDescription("Directory containing Pithos state and pdx supervisor logs."),
				Options.optional,
			),
			maxAfk: Options.integer("max-afk").pipe(
				Options.withDescription("Maximum number of supervised AFK agent runs pdx may keep active."),
				Options.withDefault(defaultMaxAfk),
			),
			intervalSeconds: Options.integer("interval-seconds").pipe(
				Options.withDescription("Seconds between pdx reconciliation loops."),
				Options.withDefault(defaultIntervalSeconds),
			),
		},
		({ dataDir, maxAfk, intervalSeconds }) =>
			Effect.gen(function* () {
				yield* parsePositiveInt(maxAfk, "--max-afk");
				yield* parsePositiveInt(intervalSeconds, "--interval-seconds");
				yield* runCommand(runtime, {
					command: "open",
					dataDir: opt(dataDir),
					maxAfk,
					intervalSeconds,
				});
			}),
	).pipe(
		Command.withDescription("Open the box: start pdx supervision and the Pandora HITL singleton."),
	);

	const close = Command.make(
		"close",
		{
			dataDir: Options.text("data-dir").pipe(
				Options.withDescription("Directory containing Pithos state and pdx supervisor logs."),
				Options.optional,
			),
		},
		({ dataDir }) => runCommand(runtime, { command: "close", dataDir: opt(dataDir) }),
	).pipe(
		Command.withDescription("Close the box: stop pdx supervision and clean up supervised runs."),
	);

	const daemonStatus = Command.make(
		"status",
		{
			dataDir: Options.text("data-dir").pipe(
				Options.withDescription("Directory containing Pithos state and pdx supervisor logs."),
				Options.optional,
			),
		},
		({ dataDir }) => runCommand(runtime, { command: "daemon.status", dataDir: opt(dataDir) }),
	).pipe(Command.withDescription("Show daemon state, supervised agents, and queue counts."));

	const daemonLogs = Command.make(
		"logs",
		{
			dataDir: Options.text("data-dir").pipe(
				Options.withDescription("Directory containing Pithos state and pdx supervisor logs."),
				Options.optional,
			),
			limit: Options.integer("limit").pipe(
				Options.withDescription("Maximum number of newest supervisor log records to print."),
				Options.optional,
			),
			since: Options.text("since").pipe(
				Options.withDescription("Only print supervisor log records at or after this timestamp."),
				Options.optional,
			),
			all: Options.boolean("all").pipe(
				Options.withDescription("Include all supervisor log records instead of the default limit."),
			),
		},
		({ dataDir, limit, since, all }) =>
			Effect.gen(function* () {
				const parsedLimit = opt(limit);
				if (parsedLimit !== undefined) {
					yield* parsePositiveInt(parsedLimit, "--limit");
				}
				yield* runCommand(runtime, {
					command: "daemon.logs",
					dataDir: opt(dataDir),
					limit: parsedLimit,
					all,
					since: opt(since),
				});
			}),
	).pipe(Command.withDescription("Show pdx daemon supervisor JSONL logs (not agent transcripts)."));

	const daemon = Command.make("daemon").pipe(
		Command.withDescription("Daemon supervisor commands."),
		Command.withSubcommands([daemonStatus, daemonLogs]),
	);

	const runKill = Command.make(
		"kill",
		{
			runId: Args.text({ name: "run-id" }),
			dataDir: Options.text("data-dir").pipe(
				Options.withDescription("Directory containing Pithos state and pdx supervisor logs."),
				Options.optional,
			),
			reason: Options.text("reason").pipe(
				Options.withDescription(
					"Operator-readable reason recorded before pdx kills the live resource.",
				),
			),
		},
		({ dataDir, runId, reason }) =>
			runCommand(runtime, { command: "run.kill", dataDir: opt(dataDir), runId, reason }),
	).pipe(Command.withDescription("Kill one live agent run after interrupting Pithos state."));

	const runTranscript = Command.make(
		"transcript",
		{
			runId: Args.text({ name: "run-id" }),
			dataDir: Options.text("data-dir").pipe(
				Options.withDescription("Directory containing Pithos state and pdx supervisor logs."),
				Options.optional,
			),
			limit: Options.integer("limit").pipe(
				Options.withDescription("Maximum number of newest harness transcript events to render."),
				Options.optional,
			),
		},
		({ dataDir, runId, limit }) =>
			Effect.gen(function* () {
				const parsedLimit = opt(limit);
				if (parsedLimit !== undefined) {
					yield* parsePositiveInt(parsedLimit, "--limit");
				}
				yield* runCommand(runtime, {
					command: "run.transcript",
					dataDir: opt(dataDir),
					runId,
					limit: parsedLimit,
				});
			}),
	).pipe(Command.withDescription("Render an agent harness transcript for a run."));

	const runShow = Command.make(
		"show",
		{
			runId: Args.text({ name: "run-id" }),
			dataDir: Options.text("data-dir").pipe(
				Options.withDescription("Directory containing Pithos state and pdx supervisor logs."),
				Options.optional,
			),
		},
		({ dataDir, runId }) =>
			runCommand(runtime, { command: "run.show", dataDir: opt(dataDir), runId }),
	).pipe(Command.withDescription("Jump the current tmux client to a supervised run session."));

	const run = Command.make("run").pipe(
		Command.withDescription("Inspect or stop supervised agent runs owned by pdx."),
		Command.withSubcommands([runKill, runTranscript, runShow]),
	);

	const taskKill = Command.make(
		"kill",
		{
			taskId: Args.text({ name: "task-id" }),
			dataDir: Options.text("data-dir").pipe(
				Options.withDescription("Directory containing Pithos state and pdx supervisor logs."),
				Options.optional,
			),
			reason: Options.text("reason").pipe(
				Options.withDescription(
					"Operator-readable reason recorded before pdx kills the holder run.",
				),
			),
		},
		({ dataDir, taskId, reason }) =>
			runCommand(runtime, { command: "task.kill", dataDir: opt(dataDir), taskId, reason }),
	).pipe(
		Command.withDescription("Kill the live run holding a task after interrupting Pithos state."),
	);

	const taskShow = Command.make(
		"show",
		{
			taskId: Args.text({ name: "task-id" }),
			dataDir: Options.text("data-dir").pipe(
				Options.withDescription("Directory containing Pithos state and pdx supervisor logs."),
				Options.optional,
			),
		},
		({ dataDir, taskId }) =>
			runCommand(runtime, { command: "task.show", dataDir: opt(dataDir), taskId }),
	).pipe(Command.withDescription("Jump to the live tmux session holding a task, if any."));

	const task = Command.make("task").pipe(
		Command.withDescription("Operate on live supervision for Pithos tasks."),
		Command.withSubcommands([taskKill, taskShow]),
	);

	return Command.make("pdx").pipe(
		Command.withDescription(
			"Local supervisor for Pandora's Box agent runs, processes, tmux sessions, and Pandora.",
		),
		Command.withSubcommands([open, close, daemon, run, task]),
	);
};

const program = captureRuntimeInput.pipe(
	Effect.flatMap((runtime) =>
		Effect.gen(function* () {
			const internal = yield* parseInternalDaemonRun(process.argv);
			if (internal !== undefined) {
				yield* runCommand(runtime, internal);
				return;
			}
			const command = makeCommand(runtime);
			const handledHelpJson = yield* handleHelpJson(process.argv, command);
			if (handledHelpJson) return;
			const cli = Command.run(command, {
				name: "Pdx",
				version: "0.1.0",
				executable: "pdx",
			});
			yield* cli(process.argv).pipe(Effect.catchAll((error) => handleError(error)));
		}),
	),
	Effect.catchAll((error) =>
		Effect.sync(() => {
			const message = error instanceof Error ? error.message : inspect(error);
			writePdxError("VALIDATION_ERROR", message);
		}),
	),
	Effect.provide(Layer.mergeAll(NodeContext.layer, CliConfig.layer({ showBuiltIns: false }))),
);

NodeRuntime.runMain(program);
