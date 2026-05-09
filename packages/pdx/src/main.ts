import { CliConfig, Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import process from "node:process";
import { inspect } from "node:util";
import { closePdx, killPdx, logsShowPdx, openPdx, runDaemon, statusPdx } from "./controller.js";
import { parsePdxConfig } from "./config.js";
import { PdxError } from "./errors.js";
import {
	ClockLive,
	FileSystemLive,
	IdsLive,
	makePithosClientLive,
	ProcessLive,
	SpawnerLive,
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
			readonly home: string | undefined;
			readonly maxAfk: number;
			readonly intervalSeconds: number;
	  }
	| { readonly command: "close"; readonly home: string | undefined }
	| { readonly command: "status"; readonly home: string | undefined }
	| {
			readonly command: "kill";
			readonly home: string | undefined;
			readonly runId: string | undefined;
			readonly taskId: string | undefined;
			readonly reason: string;
	  }
	| {
			readonly command: "logs.show";
			readonly home: string | undefined;
			readonly limit: number | undefined;
			readonly all: boolean;
			readonly since: string | undefined;
	  }
	| {
			readonly command: "daemon";
			readonly home: string | undefined;
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
	Layer.succeed(Spawner, SpawnerLive),
);

const runCommand = (runtime: RuntimeInput, input: CommandInput) =>
	Effect.gen(function* () {
		const config = yield* parsePdxConfig({
			home: input.home,
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
		);

		switch (input.command) {
			case "open":
				yield* openPdx(config, input.maxAfk, input.intervalSeconds).pipe(Effect.provide(provided));
				yield* Effect.sync(() => process.stdout.write("tmux attach -t pdx--pandora\n"));
				return;
			case "close":
				return yield* closePdx(config).pipe(Effect.provide(provided));
			case "status": {
				const status = yield* statusPdx(config, defaultMaxAfk).pipe(Effect.provide(provided));
				yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(status)}\n`));
				return;
			}
			case "kill":
				return yield* killPdx(config, {
					runId: input.runId,
					taskId: input.taskId,
					reason: input.reason,
				}).pipe(Effect.provide(provided));
			case "logs.show": {
				const outputText = yield* logsShowPdx(config, {
					limit: input.limit,
					all: input.all,
					since: input.since,
				}).pipe(Effect.provide(provided));
				yield* Effect.sync(() => process.stdout.write(outputText));
				return;
			}
			case "daemon": {
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

const makeCommand = (runtime: RuntimeInput) => {
	const open = Command.make(
		"open",
		{
			home: Options.text("home").pipe(Options.optional),
			maxAfk: Options.integer("max-afk").pipe(Options.withDefault(defaultMaxAfk)),
			intervalSeconds: Options.integer("interval-seconds").pipe(
				Options.withDefault(defaultIntervalSeconds),
			),
		},
		({ home, maxAfk, intervalSeconds }) =>
			Effect.gen(function* () {
				yield* parsePositiveInt(maxAfk, "--max-afk");
				yield* parsePositiveInt(intervalSeconds, "--interval-seconds");
				yield* runCommand(runtime, {
					command: "open",
					home: opt(home),
					maxAfk,
					intervalSeconds,
				});
			}),
	);

	const close = Command.make(
		"close",
		{
			home: Options.text("home").pipe(Options.optional),
		},
		({ home }) => runCommand(runtime, { command: "close", home: opt(home) }),
	);

	const status = Command.make(
		"status",
		{
			home: Options.text("home").pipe(Options.optional),
			json: Options.boolean("json"),
		},
		({ home }) => runCommand(runtime, { command: "status", home: opt(home) }),
	);

	const kill = Command.make(
		"kill",
		{
			home: Options.text("home").pipe(Options.optional),
			runId: Options.text("run").pipe(Options.optional),
			taskId: Options.text("task").pipe(Options.optional),
			reason: Options.text("reason"),
		},
		({ home, runId, taskId, reason }) =>
			runCommand(runtime, {
				command: "kill",
				home: opt(home),
				runId: opt(runId),
				taskId: opt(taskId),
				reason,
			}),
	);

	const logsShow = Command.make(
		"show",
		{
			home: Options.text("home").pipe(Options.optional),
			limit: Options.integer("limit").pipe(Options.optional),
			since: Options.text("since").pipe(Options.optional),
			all: Options.boolean("all"),
		},
		({ home, limit, since, all }) =>
			Effect.gen(function* () {
				const parsedLimit = opt(limit);
				if (parsedLimit !== undefined) {
					yield* parsePositiveInt(parsedLimit, "--limit");
				}
				yield* runCommand(runtime, {
					command: "logs.show",
					home: opt(home),
					limit: parsedLimit,
					all,
					since: opt(since),
				});
			}),
	);

	const logs = Command.make("logs").pipe(Command.withSubcommands([logsShow]));

	const daemon = Command.make(
		"daemon",
		{
			home: Options.text("home").pipe(Options.optional),
			maxAfk: Options.integer("max-afk").pipe(Options.withDefault(defaultMaxAfk)),
			intervalSeconds: Options.integer("interval-seconds").pipe(
				Options.withDefault(defaultIntervalSeconds),
			),
		},
		({ home, maxAfk, intervalSeconds }) =>
			Effect.gen(function* () {
				yield* parsePositiveInt(maxAfk, "--max-afk");
				yield* parsePositiveInt(intervalSeconds, "--interval-seconds");
				yield* runCommand(runtime, {
					command: "daemon",
					home: opt(home),
					maxAfk,
					intervalSeconds,
				});
			}),
	);

	return Command.make("pdx").pipe(
		Command.withSubcommands([open, close, status, kill, logs, daemon]),
	);
};

const program = captureRuntimeInput.pipe(
	Effect.flatMap((runtime) => {
		const cli = Command.run(makeCommand(runtime), {
			name: "Pdx",
			version: "0.1.0",
			executable: "pdx",
		});
		return cli(process.argv).pipe(Effect.catchAll((error) => handleError(error)));
	}),
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
