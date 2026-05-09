import { Context, Effect, SynchronizedRef } from "effect";
import type { PdxError } from "./errors.js";

export interface ProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ProcessService {
	readonly execFile: (
		file: string,
		args: readonly string[],
		options?: { readonly cwd?: string; readonly env?: Record<string, string> },
	) => Effect.Effect<ProcessResult, PdxError>;
}
export class Process extends Context.Tag("pdx/Process")<Process, ProcessService>() {}

export interface FileSystemService {
	readonly appendFile: (path: string, content: string) => Effect.Effect<void, PdxError>;
	readonly readFile: (path: string) => Effect.Effect<string, PdxError>;
	readonly mkdir: (path: string) => Effect.Effect<void, PdxError>;
}
export class FileSystem extends Context.Tag("pdx/FileSystem")<FileSystem, FileSystemService>() {}

export interface ClockService {
	readonly nowIso: Effect.Effect<string>;
}
export class Clock extends Context.Tag("pdx/Clock")<Clock, ClockService>() {}

export interface TmuxService {
	readonly hasSession: (target: string) => Effect.Effect<boolean, PdxError>;
	readonly lsSessions: () => Effect.Effect<readonly string[], PdxError>;
	readonly newSession: (input: {
		readonly target: string;
		readonly command: readonly string[];
		readonly cwd: string;
	}) => Effect.Effect<void, PdxError>;
	readonly killSession: (target: string) => Effect.Effect<void, PdxError>;
	readonly sendLiteralLine: (target: string, text: string) => Effect.Effect<void, PdxError>;
	readonly pasteBuffer: (target: string, content: string) => Effect.Effect<void, PdxError>;
}
export class Tmux extends Context.Tag("pdx/Tmux")<Tmux, TmuxService>() {}

export interface PithosClientService {
	readonly run: (
		args: readonly string[],
		options?: { readonly env?: Record<string, string> },
	) => Effect.Effect<ProcessResult, PdxError>;
}
export class PithosClient extends Context.Tag("pdx/PithosClient")<
	PithosClient,
	PithosClientService
>() {}

export interface RegistryEntry {
	readonly runId: string;
	readonly agent: "pandora" | "toil" | "greed" | "war";
	readonly scopeId: string;
	readonly mode: "afk" | "hitl";
	readonly state: "launching" | "live" | "terminating";
}

export interface RegistryService {
	readonly list: Effect.Effect<readonly RegistryEntry[]>;
	readonly upsert: (entry: RegistryEntry) => Effect.Effect<void>;
	readonly remove: (runId: string) => Effect.Effect<void>;
}
export class Registry extends Context.Tag("pdx/Registry")<Registry, RegistryService>() {}

export const makeRegistry = Effect.gen(function* () {
	const ref = yield* SynchronizedRef.make<readonly RegistryEntry[]>([]);
	return Registry.of({
		list: SynchronizedRef.get(ref),
		upsert: (entry) =>
			SynchronizedRef.update(ref, (entries) => [
				...entries.filter((existing) => existing.runId !== entry.runId),
				entry,
			]),
		remove: (runId) =>
			SynchronizedRef.update(ref, (entries) => entries.filter((entry) => entry.runId !== runId)),
	});
});

type JsonObject = { readonly [K in string]: JsonValue };

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface SupervisorLogRecord {
	readonly ts: string;
	readonly level: "debug" | "info" | "warn" | "error";
	readonly span: string;
	readonly msg: string;
	readonly data?: JsonObject;
}

export interface SupervisorLogService {
	readonly write: (
		record: Omit<SupervisorLogRecord, "ts">,
	) => Effect.Effect<SupervisorLogRecord, PdxError>;
}
export class SupervisorLog extends Context.Tag("pdx/SupervisorLog")<
	SupervisorLog,
	SupervisorLogService
>() {}
