import { Effect } from "effect";
import { PdxError } from "./errors.js";

export type ParsedCommand =
	| { readonly kind: "help" }
	| { readonly kind: "open" }
	| { readonly kind: "close" }
	| { readonly kind: "status" }
	| {
			readonly kind: "logs-show";
			readonly limit: number | undefined;
			readonly all: boolean;
			readonly since: string | undefined;
	  }
	| { readonly kind: "daemon" };

export interface ParsedPdxArgs {
	readonly command: ParsedCommand;
	readonly home: string | undefined;
	readonly intervalSecondsRaw: string | undefined;
	readonly maxAfkRaw: string | undefined;
}

interface LogsOptions {
	readonly limitRaw: string | undefined;
	readonly all: boolean;
	readonly since: string | undefined;
	readonly json: boolean;
}

const hasLogsFilterOption = (logsOptions: LogsOptions): boolean =>
	logsOptions.limitRaw !== undefined || logsOptions.all || logsOptions.since !== undefined;

const hasAfkTimingOption = (
	intervalSecondsRaw: string | undefined,
	maxAfkRaw: string | undefined,
): boolean => intervalSecondsRaw !== undefined || maxAfkRaw !== undefined;

const rejectCommandOptions = (command: string): Effect.Effect<void, PdxError> =>
	Effect.fail(
		new PdxError({
			code: "VALIDATION_ERROR",
			message: `${command} does not take command options`,
		}),
	);

const rejectLogsFilterOptions = (
	command: string,
	logsOptions: LogsOptions,
): Effect.Effect<void, PdxError> =>
	hasLogsFilterOption(logsOptions)
		? Effect.fail(
				new PdxError({
					code: "VALIDATION_ERROR",
					message: `${command} does not take logs options`,
				}),
			)
		: Effect.void;

const rejectAfkTimingOptions = (command: string): Effect.Effect<void, PdxError> =>
	Effect.fail(
		new PdxError({
			code: "VALIDATION_ERROR",
			message: `${command} does not take afk timing options`,
		}),
	);

const rejectJsonOption = (command: string): Effect.Effect<void, PdxError> =>
	Effect.fail(
		new PdxError({
			code: "VALIDATION_ERROR",
			message: `${command} does not take --json`,
		}),
	);

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

const parseCommand = (
	commandArgs: readonly string[],
	logsShowInput: LogsOptions,
	showHelp: boolean,
	intervalSecondsRaw: string | undefined,
	maxAfkRaw: string | undefined,
): Effect.Effect<ParsedCommand, PdxError> =>
	Effect.gen(function* () {
		const command = commandArgs[0];
		if (showHelp || command === undefined || commandArgs.length === 0) {
			return { kind: "help" } as const;
		}
		if (command === "open") {
			if (hasLogsFilterOption(logsShowInput)) {
				yield* rejectLogsFilterOptions("open", logsShowInput);
			}
			if (logsShowInput.json) {
				yield* rejectJsonOption("open");
			}
			if (commandArgs.length !== 1) {
				return yield* Effect.fail(
					new PdxError({
						code: "VALIDATION_ERROR",
						message: "open does not take positional arguments",
					}),
				);
			}
			return { kind: "open" } as const;
		}
		if (command === "close") {
			if (
				hasAfkTimingOption(intervalSecondsRaw, maxAfkRaw) ||
				hasLogsFilterOption(logsShowInput) ||
				logsShowInput.json
			) {
				yield* rejectCommandOptions("close");
			}
			if (commandArgs.length !== 1) {
				return yield* Effect.fail(
					new PdxError({
						code: "VALIDATION_ERROR",
						message: "close does not take positional arguments",
					}),
				);
			}
			return { kind: "close" } as const;
		}
		if (command === "status") {
			if (hasAfkTimingOption(intervalSecondsRaw, maxAfkRaw)) {
				yield* rejectAfkTimingOptions("status");
			}
			yield* rejectLogsFilterOptions("status", logsShowInput);
			if (commandArgs.length !== 1) {
				return yield* Effect.fail(
					new PdxError({
						code: "VALIDATION_ERROR",
						message: "status does not take positional arguments",
					}),
				);
			}
			return { kind: "status" } as const;
		}
		if (command === "logs") {
			if (commandArgs[1] !== "show" || commandArgs.length !== 2) {
				return yield* Effect.fail(
					new PdxError({ code: "VALIDATION_ERROR", message: "Command not implemented: logs" }),
				);
			}
			if (hasAfkTimingOption(intervalSecondsRaw, maxAfkRaw)) {
				yield* rejectAfkTimingOptions("logs show");
			}
			const limit = yield* parsePositiveInt(logsShowInput.limitRaw, "--limit");
			return {
				kind: "logs-show",
				limit,
				all: logsShowInput.all,
				since: logsShowInput.since,
			} as const;
		}
		if (command === "daemon") {
			yield* rejectLogsFilterOptions("daemon", logsShowInput);
			if (logsShowInput.json) {
				yield* rejectJsonOption("daemon");
			}
			if (commandArgs.length !== 1) {
				return yield* Effect.fail(
					new PdxError({
						code: "VALIDATION_ERROR",
						message: "daemon does not take positional arguments",
					}),
				);
			}
			return { kind: "daemon" } as const;
		}
		return yield* Effect.fail(
			new PdxError({ code: "VALIDATION_ERROR", message: `Command not implemented: ${command}` }),
		);
	});

export const parsePdxArgs = (args: readonly string[]): Effect.Effect<ParsedPdxArgs, PdxError> =>
	Effect.gen(function* () {
		const commandArgs: string[] = [];
		let home: string | undefined;
		let intervalSecondsRaw: string | undefined;
		let maxAfkRaw: string | undefined;
		let limitRaw: string | undefined;
		let since: string | undefined;
		let all = false;
		let json = false;
		let showHelp = false;

		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (!arg.startsWith("--")) {
				commandArgs.push(arg);
				continue;
			}

			switch (arg) {
				case "--home": {
					home = yield* parseOptionValue(args, index, "--home");
					index += 1;
					continue;
				}
				case "--interval-seconds": {
					intervalSecondsRaw = yield* parseOptionValue(args, index, "--interval-seconds");
					index += 1;
					continue;
				}
				case "--max-afk": {
					maxAfkRaw = yield* parseOptionValue(args, index, "--max-afk");
					index += 1;
					continue;
				}
				case "--limit": {
					limitRaw = yield* parseOptionValue(args, index, "--limit");
					index += 1;
					continue;
				}
				case "--since": {
					since = yield* parseOptionValue(args, index, "--since");
					index += 1;
					continue;
				}
				case "--all": {
					all = true;
					continue;
				}
				case "--json": {
					json = true;
					continue;
				}
				case "--help": {
					showHelp = true;
					continue;
				}
				default: {
					return yield* Effect.fail(
						new PdxError({ code: "VALIDATION_ERROR", message: `Unknown option: ${arg}` }),
					);
				}
			}
		}

		const command = yield* parseCommand(
			commandArgs,
			{ limitRaw, all, since, json },
			showHelp,
			intervalSecondsRaw,
			maxAfkRaw,
		);
		return {
			command,
			home,
			intervalSecondsRaw,
			maxAfkRaw,
		};
	});
