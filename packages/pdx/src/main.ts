import { Effect, Layer } from "effect";
import { parsePdxConfigOrThrow } from "./config.js";
import { PdxError } from "./errors.js";
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

const takeOption = (args: readonly string[], name: string): string | undefined => {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new PdxError({ code: "VALIDATION_ERROR", message: `${name} requires a value` });
	}
	return value;
};

const withoutOption = (args: readonly string[], name: string): readonly string[] => {
	const index = args.indexOf(name);
	return index === -1 ? args : args.filter((_, i) => i !== index && i !== index + 1);
};

const withoutFlag = (args: readonly string[], name: string): readonly string[] =>
	args.filter((arg) => arg !== name);

const stripOptions = (args: readonly string[]): readonly string[] =>
	["--home", "--interval-seconds", "--max-afk", "--limit", "--since"].reduce(
		(current, name) => withoutOption(current, name),
		withoutFlag(withoutFlag(args, "--all"), "--json"),
	);

const parsePositiveInt = (raw: string | undefined, name: string, fallback: number): number => {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new PdxError({ code: "VALIDATION_ERROR", message: `${name} must be a positive integer` });
	}
	return value;
};

const args = process.argv.slice(2);
const home = takeOption(args, "--home");
const commandArgs = stripOptions(args);

try {
	const config = parsePdxConfigOrThrow({
		home,
		envHome: process.env.HOME,
		daemonEntrypoint: process.argv[1],
	});
	const command = commandArgs.find((arg) => !arg.startsWith("--"));
	const intervalSeconds = parsePositiveInt(
		takeOption(args, "--interval-seconds"),
		"--interval-seconds",
		5,
	);
	const maxAfk = parsePositiveInt(takeOption(args, "--max-afk"), "--max-afk", 4);
	const limit = takeOption(args, "--limit");
	const since = takeOption(args, "--since");

	if (command === "--help" || command === undefined) {
		process.stdout.write("pdx commands: open, close, status, kill, logs show\n");
		process.exit(0);
	}

	const base = Layer.mergeAll(
		Layer.succeed(Process, ProcessLive),
		Layer.succeed(FileSystem, FileSystemLive),
		Layer.succeed(Clock, ClockLive),
		Layer.succeed(PithosClient, PithosClientLive),
		Layer.succeed(Ids, IdsLive),
		Layer.succeed(Spawner, SpawnerLive),
	);
	const program = Effect.gen(function* () {
		const tmux = yield* makeTmux;
		const supervisorLog = yield* makeSupervisorLog(config.logPath);
		const registry = yield* makeRegistry;
		const provided = Layer.mergeAll(
			Layer.succeed(Tmux, tmux),
			Layer.succeed(SupervisorLog, supervisorLog),
			Layer.succeed(Registry, registry),
		);
		if (command === "open") {
			yield* openPdx(config, maxAfk, intervalSeconds).pipe(Effect.provide(provided));
			process.stdout.write("tmux attach -t pdx--pandora\n");
			return;
		}
		if (command === "close") return yield* closePdx(config).pipe(Effect.provide(provided));
		if (command === "status") {
			const status = yield* statusPdx(config, maxAfk).pipe(Effect.provide(provided));
			process.stdout.write(`${JSON.stringify(status)}\n`);
			return;
		}
		if (command === "logs" && commandArgs[1] === "show") {
			const output = yield* logsShowPdx(config, {
				limit: limit === undefined ? undefined : parsePositiveInt(limit, "--limit", 100),
				all: args.includes("--all"),
				since,
			}).pipe(Effect.provide(provided));
			process.stdout.write(output);
			return;
		}
		if (command === "daemon") {
			const handle = yield* runDaemon(config, maxAfk, intervalSeconds).pipe(
				Effect.provide(provided),
			);
			yield* handle.shutdown;
			yield* handle.close;
			return;
		}
		yield* Effect.fail(
			new PdxError({ code: "VALIDATION_ERROR", message: `Command not implemented: ${command}` }),
		);
	}).pipe(
		Effect.provide(base),
		Effect.catchAll((error) =>
			Effect.sync(() => {
				process.stderr.write(`${error.code}: ${error.message}\n`);
				process.exitCode = 2;
			}),
		),
	);
	Effect.runPromise(program).catch((error: unknown) => {
		throw error;
	});
} catch (error) {
	if (error instanceof PdxError) {
		process.stderr.write(`${error.code}: ${error.message}\n`);
		process.exit(2);
	}
	throw error;
}
