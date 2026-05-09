import { Effect } from "effect";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { launchAgent } from "../../spawner/src/index.ts";
import { liveServices, makeEngine, PithosError } from "@pithos/pithos";
import type { Config as PithosConfig } from "@pithos/pithos";
import { PdxError } from "./errors.js";
import {
	FileSystem,
	Clock,
	Ids,
	PithosClient,
	Process,
	Spawner,
	type PithosClientService,
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
	kill: (pid, signal) =>
		Effect.try({
			try: () => void process.kill(pid, signal),
			catch: (error) =>
				new PdxError({
					code: "PROCESS_ERROR",
					message: `kill ${pid} ${signal} failed: ${String(error)}`,
				}),
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
const pithosError = (operation: string, error: unknown) => {
	if (error instanceof PdxError) return error;
	if (error instanceof PithosError) {
		return new PdxError({ code: error.code, message: `${operation} failed: ${error.message}` });
	}
	return new PdxError({ code: "PROCESS_ERROR", message: `${operation} failed: ${String(error)}` });
};

const pithosClient = (dbPath: string): PithosClientService => {
	const engine = makeEngine({
		config: { dbPath } satisfies PithosConfig,
		services: liveServices,
	});
	const run = <A>(operation: string, f: () => A) =>
		Effect.try({ try: f, catch: (error) => pithosError(operation, error) });
	return {
		init: () => run("pithos init", () => void engine.init({ fresh: false })),
		scopeUpsert: (input) =>
			run(
				"pithos scope upsert",
				() => void engine.scopeUpsert({ kind: input.kind, path: input.path }),
			),
		runUpsert: (input) =>
			run(
				"pithos run upsert",
				() =>
					void engine.runUpsert({
						agent: input.agent,
						mode: input.mode,
						scope: input.scope,
						cwd: input.cwd,
						sessionId: input.sessionId,
						runId: input.runId,
					}),
			),
		runCleanup: (input) => run("pithos run cleanup", () => void engine.runCleanup(input)),
		runInterrupt: (input) =>
			run("pithos run interrupt", () => {
				const interruptInput =
					input.expectedRunId === undefined
						? { runId: input.runId, taskId: input.taskId, reason: input.reason }
						: {
								runId: input.runId,
								taskId: input.taskId,
								reason: input.reason,
								expectedRunId: input.expectedRunId,
							};
				const result = engine.runInterrupt(interruptInput);
				return { run: result.run, interruptedTask: result.interrupted_task };
			}),
		runTimeout: (input) => run("pithos run timeout", () => void engine.runTimeout(input)),
		runInspect: (input) => run("pithos run inspect", () => engine.runInspect(input).run),
		activeRunForTask: (input) =>
			run("pithos active run for task", () => engine.activeRunForTask(input).run),
		taskHeartbeat: (input) =>
			run(
				"pithos task heartbeat",
				() => void engine.heartbeat({ runId: input.runId, taskId: undefined, token: undefined }),
			),
		taskEnqueue: (input) =>
			run(
				"pithos task enqueue",
				() =>
					void engine.enqueue({
						scope: input.scope,
						capability: input.capability,
						title: input.title,
						body: input.body,
						bodyFile: undefined,
						runId: input.runId,
						dependsOn: input.dependsOn ?? [],
					}),
			),
		briefing: () => run("pithos briefing", () => engine.briefing({ agent: undefined }).ready),
	};
};

export const makePithosClientLive = (dbPath: string) => PithosClient.of(pithosClient(dbPath));
export const SpawnerLive = Spawner.of({
	launchAgent: (input) =>
		Effect.try({
			try: () => launchAgent(input),
			catch: (error) =>
				new PdxError({ code: "PROCESS_ERROR", message: `spawner launch failed: ${String(error)}` }),
		}),
});
