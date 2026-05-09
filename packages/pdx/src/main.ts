import { Effect, Layer } from "effect";
import { parsePdxConfigOrThrow } from "./config.js";
import { PdxError } from "./errors.js";
import { ClockLive, FileSystemLive, PithosClientLive, ProcessLive } from "./live.js";
import { makeSupervisorLog } from "./log.js";
import { makeTmux } from "./tmux.js";
import { Clock, FileSystem, PithosClient, Process, SupervisorLog, Tmux } from "./services.js";
import { closePdx, openPdx, runDaemon } from "./controller.js";

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
const commandArgs = withoutOption(
	withoutOption(withoutOption(args, "--home"), "--interval-seconds"),
	"--max-afk",
);

try {
	const config = parsePdxConfigOrThrow({
		home,
		envHome: process.env.HOME,
		daemonEntrypoint: process.argv[1],
	});
	const command = commandArgs.find((arg) => !arg.startsWith("--"));
	parsePositiveInt(takeOption(args, "--interval-seconds"), "--interval-seconds", 5);
	parsePositiveInt(takeOption(args, "--max-afk"), "--max-afk", 4);

	if (command === "--help" || command === undefined) {
		process.stdout.write("pdx commands: open, close, status, kill, logs show\n");
		process.exit(0);
	}

	const base = Layer.mergeAll(
		Layer.succeed(Process, ProcessLive),
		Layer.succeed(FileSystem, FileSystemLive),
		Layer.succeed(Clock, ClockLive),
		Layer.succeed(PithosClient, PithosClientLive),
	);
	const program = Effect.gen(function* () {
		const tmux = yield* makeTmux;
		const supervisorLog = yield* makeSupervisorLog(config.logPath);
		const provided = Layer.mergeAll(
			Layer.succeed(Tmux, tmux),
			Layer.succeed(SupervisorLog, supervisorLog),
		);
		if (command === "open") return yield* openPdx(config).pipe(Effect.provide(provided));
		if (command === "close") return yield* closePdx(config).pipe(Effect.provide(provided));
		if (command === "daemon") {
			const handle = yield* runDaemon(config).pipe(Effect.provide(provided));
			yield* handle.shutdown;
			yield* handle.close;
			return;
		}
		yield* Effect.fail(
			new PdxError({ code: "VALIDATION_ERROR", message: `Command not implemented: ${command}` }),
		);
	}).pipe(Effect.provide(base));
	Effect.runPromise(program).catch((error: unknown) => {
		if (error instanceof PdxError) {
			process.stderr.write(`${error.code}: ${error.message}\n`);
			process.exit(2);
		}
		throw error;
	});
} catch (error) {
	if (error instanceof PdxError) {
		process.stderr.write(`${error.code}: ${error.message}\n`);
		process.exit(2);
	}
	throw error;
}
