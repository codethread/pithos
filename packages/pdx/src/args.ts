import { Effect } from "effect";
import { PdxError } from "./errors.js";

export type ParsedCommand =
	| { readonly kind: "help" }
	| { readonly kind: "open" }
	| { readonly kind: "close" }
	| { readonly kind: "daemon-status" }
	| {
			readonly kind: "daemon-logs";
			readonly limit: number | undefined;
			readonly all: boolean;
			readonly since: string | undefined;
	  }
	| { readonly kind: "daemon-run" }
	| { readonly kind: "run-kill"; readonly runId: string; readonly reason: string }
	| { readonly kind: "run-transcript"; readonly runId: string; readonly limit: number | undefined }
	| { readonly kind: "task-kill"; readonly taskId: string; readonly reason: string };

export interface ParsedPdxArgs {
	readonly command: ParsedCommand;
	readonly dataDir: string | undefined;
	readonly intervalSecondsRaw: string | undefined;
	readonly maxAfkRaw: string | undefined;
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

const parseOptionValue = (
	args: readonly string[],
	index: number,
	name: string,
): Effect.Effect<string, PdxError> => {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) {
		return Effect.fail(
			new PdxError({ code: "VALIDATION_ERROR", message: `${name} requires a value` }),
		);
	}
	return Effect.succeed(value);
};

const fail = (message: string): Effect.Effect<never, PdxError> =>
	Effect.fail(new PdxError({ code: "VALIDATION_ERROR", message }));

const requireNoExtra = (command: string, args: readonly string[], count: number) =>
	args.length === count ? Effect.void : fail(`${command} does not take positional arguments`);

export const parsePdxArgs = (args: readonly string[]): Effect.Effect<ParsedPdxArgs, PdxError> =>
	Effect.gen(function* () {
		const commandArgs: string[] = [];
		let dataDir: string | undefined;
		let intervalSecondsRaw: string | undefined;
		let maxAfkRaw: string | undefined;
		let limitRaw: string | undefined;
		let since: string | undefined;
		let all = false;
		let showHelp = false;
		let reason: string | undefined;

		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (!arg.startsWith("--")) {
				commandArgs.push(arg);
				continue;
			}
			switch (arg) {
				case "--data-dir":
					dataDir = yield* parseOptionValue(args, index, "--data-dir");
					index += 1;
					continue;
				case "--interval-seconds":
					intervalSecondsRaw = yield* parseOptionValue(args, index, "--interval-seconds");
					index += 1;
					continue;
				case "--max-afk":
					maxAfkRaw = yield* parseOptionValue(args, index, "--max-afk");
					index += 1;
					continue;
				case "--limit":
					limitRaw = yield* parseOptionValue(args, index, "--limit");
					index += 1;
					continue;
				case "--since":
					since = yield* parseOptionValue(args, index, "--since");
					index += 1;
					continue;
				case "--all":
					all = true;
					continue;
				case "--reason":
					reason = yield* parseOptionValue(args, index, "--reason");
					index += 1;
					continue;
				case "--help":
					showHelp = true;
					continue;
				case "--run":
				case "--task":
				case "--json":
					return yield* fail(`Unknown option: ${arg}`);
				default:
					return yield* fail(`Unknown option: ${arg}`);
			}
		}

		if (showHelp || commandArgs.length === 0) {
			return { command: { kind: "help" }, dataDir, intervalSecondsRaw, maxAfkRaw };
		}

		const [head, sub, id] = commandArgs;
		let command: ParsedCommand;
		if (head === "open") {
			yield* requireNoExtra("open", commandArgs, 1);
			if (limitRaw !== undefined || since !== undefined || all)
				yield* fail("open does not take logs options");
			command = { kind: "open" };
		} else if (head === "close") {
			yield* requireNoExtra("close", commandArgs, 1);
			if (intervalSecondsRaw !== undefined || maxAfkRaw !== undefined) {
				yield* fail("close does not take command options");
			}
			command = { kind: "close" };
		} else if (head === "daemon" && sub === "status") {
			yield* requireNoExtra("daemon status", commandArgs, 2);
			if (intervalSecondsRaw !== undefined || maxAfkRaw !== undefined) {
				yield* fail("daemon status does not take afk timing options");
			}
			if (limitRaw !== undefined || since !== undefined || all) {
				yield* fail("daemon status does not take logs options");
			}
			command = { kind: "daemon-status" };
		} else if (head === "daemon" && sub === "logs") {
			yield* requireNoExtra("daemon logs", commandArgs, 2);
			if (intervalSecondsRaw !== undefined || maxAfkRaw !== undefined) {
				yield* fail("daemon logs does not take afk timing options");
			}
			command = {
				kind: "daemon-logs",
				limit: yield* parsePositiveInt(limitRaw, "--limit"),
				all,
				since,
			};
		} else if (head === "daemon" && sub === "run") {
			yield* requireNoExtra("daemon run", commandArgs, 2);
			if (limitRaw !== undefined || since !== undefined || all) {
				yield* fail("daemon run does not take logs options");
			}
			command = { kind: "daemon-run" };
		} else if (head === "run" && sub === "kill") {
			yield* requireNoExtra("run kill", commandArgs, 3);
			const runId = id ?? (yield* fail("run kill requires <run-id>"));
			const killReason =
				reason === undefined || reason.trim() === ""
					? yield* fail("run kill requires --reason")
					: reason;
			command = { kind: "run-kill", runId, reason: killReason };
		} else if (head === "run" && sub === "transcript") {
			yield* requireNoExtra("run transcript", commandArgs, 3);
			const runId = id ?? (yield* fail("run transcript requires <run-id>"));
			command = {
				kind: "run-transcript",
				runId,
				limit: yield* parsePositiveInt(limitRaw, "--limit"),
			};
		} else if (head === "task" && sub === "kill") {
			yield* requireNoExtra("task kill", commandArgs, 3);
			const taskId = id ?? (yield* fail("task kill requires <task-id>"));
			const killReason =
				reason === undefined || reason.trim() === ""
					? yield* fail("task kill requires --reason")
					: reason;
			command = { kind: "task-kill", taskId, reason: killReason };
		} else if (head === "status" || head === "logs" || head === "kill") {
			return yield* fail(`Command not implemented: ${head}`);
		} else {
			return yield* fail(`Command not implemented: ${head}`);
		}

		return { command, dataDir, intervalSecondsRaw, maxAfkRaw };
	});
