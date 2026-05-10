import { Args, CliConfig, Command, Options } from "@effect/cli";
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
	runTranscriptPdx,
	statusPdx,
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
import {
	Clock,
	FileSystem,
	Ids,
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
			readonly command: "daemon.run";
			readonly dataDir: string | undefined;
			readonly maxAfk: number;
			readonly intervalSeconds: number;
	  };

const defaultIntervalSeconds = 5;
const defaultMaxAfk = 4;

const opt = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value);

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
		const provided = Layer.mergeAll(
			Layer.succeed(Tmux, tmux),
			Layer.succeed(SupervisorLog, supervisorLog),
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
		return Effect.sync(() => {
			process.stderr.write(`${error.code}: ${error.message}\n`);
			process.exitCode = 2;
		});
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

const makeCommand = (runtime: RuntimeInput) => {
	const open = Command.make(
		"open",
		{
			dataDir: Options.text("data-dir").pipe(Options.optional),
			maxAfk: Options.integer("max-afk").pipe(Options.withDefault(defaultMaxAfk)),
			intervalSeconds: Options.integer("interval-seconds").pipe(
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
	);

	const close = Command.make(
		"close",
		{
			dataDir: Options.text("data-dir").pipe(Options.optional),
		},
		({ dataDir }) => runCommand(runtime, { command: "close", dataDir: opt(dataDir) }),
	);

	const daemonStatus = Command.make(
		"status",
		{ dataDir: Options.text("data-dir").pipe(Options.optional) },
		({ dataDir }) => runCommand(runtime, { command: "daemon.status", dataDir: opt(dataDir) }),
	).pipe(Command.withDescription("Show daemon state, supervised agents, and queue counts."));

	const daemonLogs = Command.make(
		"logs",
		{
			dataDir: Options.text("data-dir").pipe(Options.optional),
			limit: Options.integer("limit").pipe(Options.optional),
			since: Options.text("since").pipe(Options.optional),
			all: Options.boolean("all"),
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
			dataDir: Options.text("data-dir").pipe(Options.optional),
			reason: Options.text("reason"),
		},
		({ dataDir, runId, reason }) =>
			runCommand(runtime, { command: "run.kill", dataDir: opt(dataDir), runId, reason }),
	);

	const runTranscript = Command.make(
		"transcript",
		{
			runId: Args.text({ name: "run-id" }),
			dataDir: Options.text("data-dir").pipe(Options.optional),
			limit: Options.integer("limit").pipe(Options.optional),
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

	const run = Command.make("run").pipe(Command.withSubcommands([runKill, runTranscript]));

	const taskKill = Command.make(
		"kill",
		{
			taskId: Args.text({ name: "task-id" }),
			dataDir: Options.text("data-dir").pipe(Options.optional),
			reason: Options.text("reason"),
		},
		({ dataDir, taskId, reason }) =>
			runCommand(runtime, { command: "task.kill", dataDir: opt(dataDir), taskId, reason }),
	);

	const task = Command.make("task").pipe(Command.withSubcommands([taskKill]));

	return Command.make("pdx").pipe(Command.withSubcommands([open, close, daemon, run, task]));
};

const program = captureRuntimeInput.pipe(
	Effect.flatMap((runtime) =>
		Effect.gen(function* () {
			const internal = yield* parseInternalDaemonRun(process.argv);
			if (internal !== undefined) {
				yield* runCommand(runtime, internal);
				return;
			}
			const cli = Command.run(makeCommand(runtime), {
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
			process.stderr.write(`VALIDATION_ERROR: ${message}\n`);
			process.exitCode = 2;
		}),
	),
	Effect.provide(Layer.mergeAll(NodeContext.layer, CliConfig.layer({ showBuiltIns: false }))),
);

NodeRuntime.runMain(program);
