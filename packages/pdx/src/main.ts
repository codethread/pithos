import { Effect, Layer } from "effect";
import * as nodeProcess from "node:process";
import { parsePdxConfig } from "./config.js";
import { PdxError } from "./errors.js";
import { parsePdxArgs } from "./args.js";
import {
	ClockLive,
	FileSystemLive,
	IdsLive,
	PithosClientLive,
	ProcessLive,
	SpawnerLive,
} from "./live.js";
import { makeSupervisorLog } from "./log.js";
import { makeTmux } from "./tmux.js";
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
import { closePdx, logsShowPdx, openPdx, runDaemon, statusPdx } from "./controller.js";

interface RuntimeInput {
	readonly args: readonly string[];
	readonly envHome: string | undefined;
	readonly daemonEntrypoint: string | undefined;
}

interface RuntimeOutput {
	readonly writeStdout: (value: string) => Effect.Effect<void>;
	readonly writeStderr: (value: string) => Effect.Effect<void>;
	readonly setExitCode: (code: number) => Effect.Effect<void>;
}

const parsePositiveInt = (
	raw: string | undefined,
	name: string,
): Effect.Effect<number | undefined, PdxError> => {
	if (raw === undefined) return Effect.succeed(undefined);
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		return Effect.fail(
			new PdxError({ code: "VALIDATION_ERROR", message: `${name} must be a positive integer` }),
		);
	}
	return Effect.succeed(value);
};

const captureRuntimeInput = Effect.sync<RuntimeInput>(() => ({
	args: nodeProcess.argv.slice(2),
	envHome: nodeProcess.env.HOME,
	daemonEntrypoint: nodeProcess.argv[1],
}));

const createRuntimeOutput = Effect.sync<RuntimeOutput>(() => ({
	writeStdout: (value) =>
		Effect.sync(() => {
			nodeProcess.stdout.write(value);
		}),
	writeStderr: (value) =>
		Effect.sync(() => {
			nodeProcess.stderr.write(value);
		}),
	setExitCode: (code) =>
		Effect.sync(() => {
			process.exitCode = code;
		}),
}));

const runCommand = (input: RuntimeInput, output: RuntimeOutput) =>
	Effect.gen(function* () {
		const args = input.args;
		const parsed = yield* parsePdxArgs(args);
		const intervalSeconds = yield* parsePositiveInt(
			parsed.intervalSecondsRaw,
			"--interval-seconds",
		).pipe(Effect.map((value) => value ?? 5));
		const maxAfk = yield* parsePositiveInt(parsed.maxAfkRaw, "--max-afk").pipe(
			Effect.map((value) => value ?? 4),
		);

		const config = yield* parsePdxConfig({
			home: parsed.home,
			envHome: input.envHome,
			daemonEntrypoint: input.daemonEntrypoint,
		});
		const command = parsed.command;

		const base = Layer.mergeAll(
			Layer.succeed(Process, ProcessLive),
			Layer.succeed(FileSystem, FileSystemLive),
			Layer.succeed(Clock, ClockLive),
			Layer.succeed(PithosClient, PithosClientLive),
			Layer.succeed(Ids, IdsLive),
			Layer.succeed(Spawner, SpawnerLive),
		);
		const commandProgram = Effect.gen(function* () {
			const tmux = yield* makeTmux;
			const supervisorLog = yield* makeSupervisorLog(config.logPath);
			const registry = yield* makeRegistry;
			const provided = Layer.mergeAll(
				Layer.succeed(Tmux, tmux),
				Layer.succeed(SupervisorLog, supervisorLog),
				Layer.succeed(Registry, registry),
			);
			switch (command.kind) {
				case "help":
					yield* output.writeStdout("pdx commands: open, close, status, logs show\n");
					return;
				case "open":
					yield* openPdx(config, maxAfk, intervalSeconds).pipe(Effect.provide(provided));
					yield* output.writeStdout("tmux attach -t pdx--pandora\n");
					return;
				case "close":
					return yield* closePdx(config).pipe(Effect.provide(provided));
				case "status": {
					const status = yield* statusPdx(config, maxAfk).pipe(Effect.provide(provided));
					yield* output.writeStdout(`${JSON.stringify(status)}\n`);
					return;
				}
				case "logs-show": {
					const outputText = yield* logsShowPdx(config, {
						limit: command.limit,
						all: command.all,
						since: command.since,
					}).pipe(Effect.provide(provided));
					yield* output.writeStdout(outputText);
					return;
				}
				case "daemon": {
					const handle = yield* runDaemon(config, maxAfk, intervalSeconds).pipe(
						Effect.provide(provided),
					);
					yield* handle.shutdown;
					yield* handle.close;
					return;
				}
			}
		}).pipe(Effect.provide(base));

		yield* commandProgram;
	});

const handleError = (error: unknown, output: RuntimeOutput): Effect.Effect<void, unknown> => {
	if (error instanceof PdxError) {
		return output
			.writeStderr(`${error.code}: ${error.message}\n`)
			.pipe(Effect.zipRight(output.setExitCode(2)));
	}
	return Effect.fail(error);
};

const program = captureRuntimeInput.pipe(
	Effect.flatMap((input) =>
		createRuntimeOutput.pipe(
			Effect.flatMap((output) =>
				runCommand(input, output).pipe(Effect.catchAll((error) => handleError(error, output))),
			),
		),
	),
);

void Effect.runPromise(program);
