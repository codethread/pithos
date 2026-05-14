import { Effect } from "effect";
import {
	access,
	appendFile,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	bundledTemplatesDir,
	launchRenderedAgent,
	LiveSpawnerServices as liveSpawnerServices,
	renderAgent,
	renderSessionTranscript,
	SpawnerError,
} from "@pdx/spawner";
import { liveServices, makeEngine, pickThreeWords, PithosError } from "@pdx/pithos";
import type { Config as PithosConfig } from "@pdx/pithos";
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
		Effect.gen(function* () {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "ESRCH"
				) {
					return false;
				}
				return yield* Effect.fail(
					new PdxError({
						code: "PROCESS_ERROR",
						message: `probe ${pid} failed: ${String(error)}`,
					}),
				);
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
	readDirectory: (path) =>
		Effect.tryPromise({
			try: () => readdir(path),
			catch: (error) => fsError("readDirectory", error),
		}),
	existsDirectory: (path) =>
		Effect.tryPromise({
			try: async () => {
				try {
					return (await stat(path)).isDirectory();
				} catch (error) {
					if (isNodeErrorCode(error, "ENOENT")) return false;
					throw error;
				}
			},
			catch: (error) => fsError("existsDirectory", error),
		}),
	mkdir: (path) =>
		Effect.tryPromise({
			try: () => mkdir(path, { recursive: true }),
			catch: (error) => fsError("mkdir", error),
		}).pipe(Effect.asVoid),
	writeFileAtomic: (path, content) =>
		Effect.tryPromise({
			try: async () => {
				const tmpPath = `${path}.tmp`;
				await writeFile(tmpPath, content, "utf8");
				await rename(tmpPath, path);
			},
			catch: (error) => fsError("writeFileAtomic", error),
		}).pipe(Effect.asVoid),
	removeFile: (path) =>
		Effect.tryPromise({
			try: () => rm(path, { force: true, recursive: true }),
			catch: (error) => fsError("removeFile", error),
		}).pipe(Effect.asVoid),
});
export const ClockLive = Clock.of({ nowIso: Effect.sync(() => new Date().toISOString()) });
export const IdsLive = Ids.of({
	nextRunId: Effect.sync(() => `run_${pickThreeWords()}`),
	nextSessionId: Effect.sync(() => randomUUID()),
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
						harnessKind: input.harnessKind,
						sessionLogPath: input.sessionLogPath,
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
		runLaunchAbort: (input) =>
			run("pithos run launch abort", () => void engine.runLaunchAbort(input)),
		runInspect: (input) => run("pithos run inspect", () => engine.runInspect(input).run),
		activeRunForTask: (input) =>
			run("pithos active run for task", () => engine.activeRunForTask(input).run),
		taskInspect: (input) => run("pithos task inspect", () => engine.taskInspect(input)),
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
						chain: "auto",
					}),
			),
		escalateLaunchPrecondition: (input) =>
			run(
				"pithos launch precondition escalation",
				() => void engine.escalateLaunchPrecondition(input),
			),
		createRepairEscalation: (input) =>
			run("pithos repair escalation", () => void engine.createRepairEscalation(input)),
		briefing: () => run("pithos briefing", () => engine.briefing({ agent: undefined }).ready),
	};
};

export const makePithosClientLive = (dbPath: string) => PithosClient.of(pithosClient(dbPath));
const spawnerError = (operation: string, error: unknown) => {
	if (error instanceof PdxError) return error;
	if (error instanceof SpawnerError) {
		const code =
			error.code === "VALIDATION_ERROR"
				? "VALIDATION_ERROR"
				: error.code === "TEMPLATE_ERROR"
					? "CONFIG_ERROR"
					: error.code === "HARNESS_ERROR"
						? "HARNESS_ERROR"
						: "LAUNCH_ERROR";
		return new PdxError({
			code,
			message: `${operation} failed (${error.code}): ${error.message}`,
		});
	}
	return new PdxError({ code: "PROCESS_ERROR", message: `${operation} failed: ${String(error)}` });
};

const isNodeErrorCode = (error: unknown, code: string): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === code;

const materializeSpawnerTemplates = async (dataDir: string): Promise<void> => {
	const targetDir = join(dataDir, "templates");
	const targetAgentsPath = join(targetDir, "agents.json");
	await mkdir(targetDir, { recursive: true });
	try {
		await access(targetAgentsPath);
		return;
	} catch (error) {
		if (!isNodeErrorCode(error, "ENOENT")) throw error;
	}
	const entries = await readdir(bundledTemplatesDir, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = join(bundledTemplatesDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		try {
			if (entry.isFile()) {
				const content = await readFile(sourcePath, "utf8");
				await writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
			} else if (entry.isSymbolicLink()) {
				await symlink(await readlink(sourcePath), targetPath);
			}
		} catch (error) {
			if (!isNodeErrorCode(error, "EEXIST")) throw error;
		}
	}
};

export const makeSpawnerLive = (config: {
	readonly dataDir: string;
	readonly pithosDbPath: string;
}) => {
	const renderServices = {
		readText: liveSpawnerServices.readText,
		env: (key: string) => {
			if (key === "PDX_DATA_DIR") return config.dataDir;
			if (key === "PITHOS_DB") return config.pithosDbPath;
			return liveSpawnerServices.env(key);
		},
		execFile: liveSpawnerServices.execFile,
		writeTempText: liveSpawnerServices.writeTempText,
	};
	return Spawner.of({
		materializeTemplates: () =>
			Effect.tryPromise({
				try: () => materializeSpawnerTemplates(config.dataDir),
				catch: (error) => spawnerError("spawner template materialize", error),
			}),
		renderAgent: (input) =>
			Effect.tryPromise({
				try: async () => {
					await materializeSpawnerTemplates(config.dataDir);
					return renderAgent(input, renderServices);
				},
				catch: (error) => spawnerError("spawner render", error),
			}),
		launchRenderedAgent: (rendered) =>
			Effect.tryPromise({
				try: async () => {
					const stdoutPath = `${config.dataDir}/runs/${rendered.runId}.stdout.log`;
					const stderrPath = `${config.dataDir}/runs/${rendered.runId}.stderr.log`;
					await Promise.all([writeFile(stdoutPath, "", "utf8"), writeFile(stderrPath, "", "utf8")]);
					const [stdout, stderr] = await Promise.all([
						open(stdoutPath, "a"),
						open(stderrPath, "a"),
					]);
					try {
						return launchRenderedAgent(rendered, {
							...renderServices,
							spawnProcess: (file, args, options) => {
								const child = spawn(file, args, {
									cwd: options.cwd,
									env: {
										...process.env,
										PDX_DATA_DIR: config.dataDir,
										PITHOS_DB: config.pithosDbPath,
										...options.env,
									},
									stdio: ["ignore", stdout.fd, stderr.fd],
									detached: false,
								});
								return child.pid === undefined ? {} : { pid: child.pid };
							},
							execFile: liveSpawnerServices.execFile,
						});
					} finally {
						await Promise.all([stdout.close(), stderr.close()]);
					}
				},
				catch: (error) => spawnerError("spawner launch", error),
			}),
		renderSessionTranscript: (input) =>
			Effect.try({
				try: () =>
					input.limit === undefined
						? renderSessionTranscript(
								{ harnessKind: input.harnessKind, sessionLogPath: input.sessionLogPath },
								renderServices,
							)
						: renderSessionTranscript(
								{
									harnessKind: input.harnessKind,
									sessionLogPath: input.sessionLogPath,
									limit: input.limit,
								},
								renderServices,
							),
				catch: (error) => spawnerError("spawner transcript", error),
			}),
	});
};
