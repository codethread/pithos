import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import process from "node:process";
import { Context, Effect, Layer } from "effect";
import { PithosError } from "./errors.js";
import { pickThreeWords } from "./wordlists/index.js";

export interface FsService {
	readonly readText: (path: string) => Effect.Effect<string, PithosError>;
	readonly removeFile: (path: string) => Effect.Effect<void, PithosError>;
	readonly existsDirectory: (path: string) => Effect.Effect<boolean, PithosError>;
}

export interface IdService {
	readonly make: (prefix: string) => Effect.Effect<string>;
}

export interface ClockService {
	readonly nowIso: () => Effect.Effect<string>;
}

export interface OutputService {
	readonly write: (text: string) => Effect.Effect<void>;
	readonly writeError: (text: string) => Effect.Effect<void>;
	readonly isTty: () => boolean;
}

export type StdinState =
	| { readonly _tag: "NoRedirectedStdin" }
	| { readonly _tag: "RedirectedText"; readonly text: string }
	| { readonly _tag: "ReadFailure"; readonly error: PithosError };

export interface InputService {
	readonly readStdin: () => Effect.Effect<StdinState>;
}

export interface Services {
	readonly fs: FsService;
	readonly input: InputService;
	readonly output: OutputService;
	readonly ids: IdService;
	readonly clock: ClockService;
}

export class PithosServices extends Context.Tag("PithosServices")<PithosServices, Services>() {}

const isMissingPathError = (error: unknown): boolean => {
	if (!(error instanceof Error)) return false;
	if (!("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
};

export const liveServices: Services = {
	fs: {
		readText: (path) =>
			Effect.try({
				try: () => readFileSync(path, "utf8"),
				catch: (error) =>
					new PithosError({
						code: "USER_ERROR",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		removeFile: (path) =>
			Effect.try({
				try: () => rmSync(path, { force: true }),
				catch: (error) =>
					new PithosError({
						code: "USER_ERROR",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
		existsDirectory: (path) =>
			Effect.suspend(() => {
				try {
					return Effect.succeed(statSync(path).isDirectory());
				} catch (error) {
					if (isMissingPathError(error)) return Effect.succeed(false);
					return Effect.fail(
						new PithosError({
							code: "USER_ERROR",
							message: error instanceof Error ? error.message : String(error),
						}),
					);
				}
			}),
	},
	input: {
		readStdin: () =>
			Effect.sync(() => {
				if (process.stdin.isTTY) return { _tag: "NoRedirectedStdin" as const };
				try {
					return { _tag: "RedirectedText" as const, text: readFileSync(0, "utf8") };
				} catch (error) {
					return {
						_tag: "ReadFailure" as const,
						error: new PithosError({
							code: "USER_ERROR",
							message: error instanceof Error ? error.message : String(error),
						}),
					};
				}
			}),
	},
	output: {
		write: (text) => Effect.sync(() => void process.stdout.write(text)),
		writeError: (text) => Effect.sync(() => void process.stderr.write(text)),
		isTty: () => Boolean(process.stdout.isTTY),
	},
	ids: {
		make: (prefix) =>
			Effect.sync(() =>
				prefix === "event"
					? `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`
					: `${prefix}_${pickThreeWords()}`,
			),
	},
	clock: {
		nowIso: () => Effect.sync(() => new Date().toISOString()),
	},
};

export const LiveServicesLayer = Layer.succeed(PithosServices, liveServices);
