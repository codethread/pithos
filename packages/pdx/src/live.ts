import { Effect } from "effect";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { launchAgent } from "../../spawner/src/index.ts";
import { PdxError } from "./errors.js";
import {
	FileSystem,
	Clock,
	Ids,
	PithosClient,
	Process,
	Spawner,
	type ProcessResult,
} from "./services.js";

const execFileEffect = (
	file: string,
	args: readonly string[],
	options?: { readonly cwd?: string; readonly env?: Record<string, string> },
) =>
	Effect.async<ProcessResult, PdxError>((resume) => {
		execFile(
			file,
			[...args],
			{ cwd: options?.cwd, env: { ...process.env, ...options?.env } },
			(error, stdout, stderr) => {
				if (error !== null && typeof error.code !== "number") {
					resume(
						Effect.fail(
							new PdxError({
								code: "PROCESS_ERROR",
								message: `${file} failed to start: ${error.message}`,
							}),
						),
					);
					return;
				}
				resume(
					Effect.succeed({
						exitCode: typeof error?.code === "number" ? error.code : 0,
						stdout,
						stderr,
					}),
				);
			},
		);
	});

export const ProcessLive = Process.of({
	execFile: execFileEffect,
	isAlive: (pid) =>
		Effect.sync(() => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		}),
});
const fsError = (operation: string, error: unknown) =>
	new PdxError({ code: "FS_ERROR", message: `${operation} failed: ${String(error)}` });

export const FileSystemLive = FileSystem.of({
	appendFile: (path, content) =>
		Effect.tryPromise({
			try: () => appendFile(path, content),
			catch: (error) => fsError("appendFile", error),
		}),
	readFile: (path) =>
		Effect.tryPromise({
			try: () => readFile(path, "utf8"),
			catch: (error) => fsError("readFile", error),
		}),
	mkdir: (path) =>
		Effect.tryPromise({
			try: () => mkdir(path, { recursive: true }),
			catch: (error) => fsError("mkdir", error),
		}).pipe(Effect.asVoid),
});
export const ClockLive = Clock.of({ nowIso: Effect.sync(() => new Date().toISOString()) });
export const IdsLive = Ids.of({
	nextRunId: Effect.sync(() => `run_${randomUUID().replaceAll("-", "")}`),
	nextSessionId: Effect.sync(() => `session_${randomUUID().replaceAll("-", "")}`),
});
export const PithosClientLive = PithosClient.of({
	run: (args, options) => execFileEffect("pithos-next", args, options),
});
export const SpawnerLive = Spawner.of({
	launchAgent: (input) =>
		Effect.try({
			try: () => launchAgent(input),
			catch: (error) =>
				new PdxError({ code: "PROCESS_ERROR", message: `spawner launch failed: ${String(error)}` }),
		}),
});
