import { Deferred, Effect, Fiber, Schedule } from "effect";
import { requestIpc, listenIpc } from "./ipc-socket.js";
import type { IpcResponse } from "./ipc.js";
import { PdxError } from "./errors.js";
import type { PdxConfig } from "./config.js";
import {
	FileSystem,
	Ids,
	PithosClient,
	Process,
	Registry,
	Spawner,
	SupervisorLog,
	Tmux,
	type PithosClientService,
	type RegistryEntry,
	type TmuxService,
} from "./services.js";

export const DAEMON_TARGET = "pdx--daemon";
export const PANDORA_TARGET = "pdx--pandora";
export const PDX_SYSTEM_RUN_ID = "run_pdx_system";

const pithosEnv = (config: PdxConfig): Record<string, string> => ({
	PITHOS_DB: config.pithosDbPath,
});

const requireOk = (label: string, result: { readonly exitCode: number; readonly stderr: string }) =>
	result.exitCode === 0
		? Effect.void
		: Effect.fail(
				new PdxError({
					code: "PROCESS_ERROR",
					message: `${label} failed: ${result.stderr}`,
				}),
			);

const awaitDaemonReady = (
	socketPath: string,
	attemptsRemaining: number,
): Effect.Effect<IpcResponse, PdxError> =>
	requestIpc(socketPath, { kind: "ping" }).pipe(
		Effect.catchAll((error) => {
			if (attemptsRemaining <= 1) return Effect.fail(error);
			return Effect.sleep("100 millis").pipe(
				Effect.zipRight(awaitDaemonReady(socketPath, attemptsRemaining - 1)),
			);
		}),
	);

const isMissingTmuxSessionError = (error: PdxError): boolean =>
	error.message.includes("can't find session") || error.message.includes("no server running");

export const openPdx = (config: PdxConfig, maxAfk: number, intervalSeconds: number) =>
	Effect.gen(function* () {
		const tmux = yield* Tmux;
		const fs = yield* FileSystem;
		const pithos = yield* PithosClient;
		const exists = yield* tmux.hasSession(DAEMON_TARGET);
		if (exists) {
			yield* Effect.fail(
				new PdxError({ code: "VALIDATION_ERROR", message: `${DAEMON_TARGET} already exists` }),
			);
		}
		yield* fs.mkdir(config.home);
		yield* pithos
			.run(["init"], { env: pithosEnv(config) })
			.pipe(Effect.flatMap((result) => requireOk("pithos init", result)));
		yield* fs.mkdir(config.runsDir);
		yield* tmux.newSession({
			target: DAEMON_TARGET,
			cwd: config.home,
			command: [
				process.execPath,
				config.daemonEntrypoint,
				"daemon",
				"--home",
				config.home,
				"--max-afk",
				String(maxAfk),
				"--interval-seconds",
				String(intervalSeconds),
			],
		});
		const response = yield* awaitDaemonReady(config.socketPath, 50);
		if (!response.ok) {
			yield* Effect.fail(
				new PdxError({ code: "IPC_ERROR", message: response.error ?? "daemon ping failed" }),
			);
		}
	});

export const closePdx = (config: PdxConfig) =>
	Effect.gen(function* () {
		const tmux = yield* Tmux;
		const exists = yield* tmux.hasSession(DAEMON_TARGET);
		if (!exists) {
			yield* Effect.fail(
				new PdxError({ code: "VALIDATION_ERROR", message: `${DAEMON_TARGET} is not running` }),
			);
		}
		const response = yield* requestIpc(config.socketPath, { kind: "stop" });
		if (!response.ok) {
			yield* Effect.fail(
				new PdxError({ code: "IPC_ERROR", message: response.error ?? "daemon stop failed" }),
			);
		}
		yield* tmux
			.killSession(DAEMON_TARGET)
			.pipe(
				Effect.catchAll((error) =>
					isMissingTmuxSessionError(error) ? Effect.void : Effect.fail(error),
				),
			);
	});

const parseJsonOutput = (label: string, raw: string): Effect.Effect<unknown, PdxError> =>
	Effect.try({
		try: (): unknown => JSON.parse(raw) as unknown,
		catch: (error) =>
			new PdxError({
				code: "PROCESS_ERROR",
				message: `${label} returned invalid JSON: ${String(error)}`,
			}),
	});

const readyTasks = (
	briefing: unknown,
): readonly { readonly scope_id: string; readonly capability: string }[] => {
	if (typeof briefing !== "object" || briefing === null || !("ready" in briefing)) {
		throw new PdxError({ code: "PROCESS_ERROR", message: "pithos briefing output missing ready" });
	}
	const ready = (briefing as { readonly ready: unknown }).ready;
	if (!Array.isArray(ready)) {
		throw new PdxError({ code: "PROCESS_ERROR", message: "pithos briefing ready is not an array" });
	}
	return ready.map((task) => {
		const scope_id =
			typeof task === "object" && task !== null
				? (task as { readonly scope_id?: unknown }).scope_id
				: undefined;
		const capability =
			typeof task === "object" && task !== null
				? (task as { readonly capability?: unknown }).capability
				: undefined;
		if (typeof scope_id !== "string" || typeof capability !== "string") {
			throw new PdxError({
				code: "PROCESS_ERROR",
				message: "pithos briefing ready task missing scope/capability",
			});
		}
		return { scope_id, capability };
	});
};

const queueCounts = (briefing: unknown) =>
	Effect.try({
		try: () => {
			const ready = readyTasks(briefing);
			const byScopeCapability: Record<string, Record<string, number>> = {};
			for (const { scope_id, capability } of ready) {
				byScopeCapability[scope_id] = byScopeCapability[scope_id] ?? {};
				byScopeCapability[scope_id][capability] =
					(byScopeCapability[scope_id][capability] ?? 0) + 1;
			}
			return { claimable: ready.length, by_scope_capability: byScopeCapability };
		},
		catch: (error) =>
			error instanceof PdxError
				? error
				: new PdxError({ code: "PROCESS_ERROR", message: `queue count failed: ${String(error)}` }),
	});

const readDaemonStatus = (config: PdxConfig, running: boolean, fallback: number) => {
	if (!running)
		return Effect.succeed({ maxAfk: fallback, entries: [] as readonly RegistryEntry[] });
	return requestIpc(config.socketPath, { kind: "status" }).pipe(
		Effect.flatMap((response) => {
			if (!response.ok) {
				return Effect.fail(
					new PdxError({ code: "IPC_ERROR", message: response.error ?? "daemon status failed" }),
				);
			}
			const value = response.data?.max_afk;
			const entries = response.data?.registry_entries;
			if (typeof value !== "number" || !Array.isArray(entries)) {
				return Effect.fail(
					new PdxError({ code: "IPC_ERROR", message: "daemon status missing registry/max_afk" }),
				);
			}
			return Effect.succeed({ maxAfk: value, entries: entries as readonly RegistryEntry[] });
		}),
	);
};

export const statusPdx = (config: PdxConfig, maxAfk: number) =>
	Effect.gen(function* () {
		const tmux = yield* Tmux;
		const fs = yield* FileSystem;
		const pithos = yield* PithosClient;
		const running = yield* tmux.hasSession(DAEMON_TARGET);
		const daemonStatus = yield* readDaemonStatus(config, running, maxAfk);
		yield* fs.mkdir(config.home);
		yield* pithos
			.run(["init"], { env: pithosEnv(config) })
			.pipe(Effect.flatMap((result) => requireOk("pithos init", result)));
		const result = yield* pithos.run(["briefing"], { env: pithosEnv(config) });
		yield* requireOk("pithos briefing", result);
		const briefing = yield* parseJsonOutput("pithos briefing", result.stdout);
		const queue = yield* queueCounts(briefing);
		return {
			daemon: { running, target: DAEMON_TARGET, socket_path: config.socketPath },
			registry: { entries: daemonStatus.entries },
			queue,
			caps: {
				max_afk: daemonStatus.maxAfk,
				afk_used: daemonStatus.entries.filter((entry) => entry.mode === "afk").length,
			},
		};
	});

const sinceCutoff = (raw: string, now: Date): number => {
	const duration = /^(\d+)([mhdw])$/.exec(raw);
	if (duration !== null) {
		const amount = Number(duration[1]);
		const unit = duration[2];
		const millis =
			unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
		return now.getTime() - amount * millis;
	}
	if (raw === "today" || raw === "yesterday") {
		const start = new Date(now);
		start.setHours(0, 0, 0, 0);
		if (raw === "yesterday") start.setDate(start.getDate() - 1);
		return start.getTime();
	}
	const parsed = Date.parse(raw);
	if (Number.isNaN(parsed)) {
		throw new PdxError({ code: "VALIDATION_ERROR", message: `invalid --since value: ${raw}` });
	}
	return parsed;
};

const logLines = (raw: string): readonly string[] =>
	raw === "" ? [] : raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");

const logTimestamp = (line: string): number => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line) as unknown;
	} catch (error) {
		throw new PdxError({
			code: "VALIDATION_ERROR",
			message: `corrupt supervisor log JSONL: ${String(error)}`,
		});
	}
	const ts =
		typeof parsed === "object" && parsed !== null
			? (parsed as { readonly ts?: unknown }).ts
			: undefined;
	const timestamp = typeof ts === "string" ? Date.parse(ts) : NaN;
	if (Number.isNaN(timestamp)) {
		throw new PdxError({
			code: "VALIDATION_ERROR",
			message: "corrupt supervisor log JSONL: missing valid ts",
		});
	}
	return timestamp;
};

export const logsShowPdx = (
	config: PdxConfig,
	input: {
		readonly limit: number | undefined;
		readonly all: boolean;
		readonly since: string | undefined;
	},
) =>
	Effect.gen(function* () {
		if (input.limit !== undefined && input.all) {
			yield* Effect.fail(
				new PdxError({ code: "VALIDATION_ERROR", message: "use --limit or --all, not both" }),
			);
		}
		const fs = yield* FileSystem;
		const raw = yield* fs.readFile(config.logPath);
		const selected = yield* Effect.try({
			try: () => {
				const cutoff = input.since === undefined ? undefined : sinceCutoff(input.since, new Date());
				const matching = logLines(raw).filter((line) => {
					const timestamp = logTimestamp(line);
					return cutoff === undefined || timestamp >= cutoff;
				});
				return input.all ? matching : matching.slice(-(input.limit ?? 100));
			},
			catch: (error) =>
				error instanceof PdxError
					? error
					: new PdxError({
							code: "VALIDATION_ERROR",
							message: `log parsing failed: ${String(error)}`,
						}),
		});
		return selected.length === 0 ? "" : `${selected.join("\n")}\n`;
	});

const pithosRun = (
	pithos: PithosClientService,
	config: PdxConfig,
	label: string,
	args: readonly string[],
) =>
	pithos
		.run(args, { env: pithosEnv(config) })
		.pipe(Effect.flatMap((result) => requireOk(label, result)));

const cleanupRun = (
	pithos: PithosClientService,
	config: PdxConfig,
	runId: string,
	reason: string,
) =>
	pithosRun(pithos, config, "pithos run cleanup", [
		"run",
		"cleanup",
		"--run",
		runId,
		"--reason",
		reason,
	]);

const confirmTmuxGone = (tmux: TmuxService, target: string) =>
	tmux.hasSession(target).pipe(
		Effect.flatMap((exists) =>
			exists
				? Effect.fail(
						new PdxError({
							code: "PROCESS_ERROR",
							message: `${target} still exists after kill`,
						}),
					)
				: Effect.void,
		),
	);

export const isAfkAlive = (pid: number) =>
	Process.pipe(Effect.flatMap((process) => process.isAlive(pid)));

const entryAlive = (entry: RegistryEntry) =>
	Effect.gen(function* () {
		if (entry.mode === "hitl") {
			const target = entry.tmuxTarget;
			if (target === undefined) {
				yield* Effect.fail(
					new PdxError({ code: "VALIDATION_ERROR", message: `${entry.runId} missing tmux target` }),
				);
			} else {
				const tmux = yield* Tmux;
				return yield* tmux.hasSession(target);
			}
		}
		const pid = entry.pid;
		if (pid === undefined) {
			yield* Effect.fail(
				new PdxError({ code: "VALIDATION_ERROR", message: `${entry.runId} missing pid` }),
			);
			return false;
		}
		return yield* isAfkAlive(pid);
	});

export const reconcileTick = (config: PdxConfig) =>
	Effect.gen(function* () {
		const registry = yield* Registry;
		const pithos = yield* PithosClient;
		const ids = yield* Ids;
		const spawner = yield* Spawner;
		const log = yield* SupervisorLog;
		for (const entry of yield* registry.list) {
			const alive = yield* entryAlive(entry);
			if (!alive) {
				yield* cleanupRun(pithos, config, entry.runId, "natural_death");
				yield* registry.remove(entry.runId);
				yield* log.write({
					level: "info",
					span: "pdx.reconcile",
					msg: "removed dead entry",
					data: { run_id: entry.runId },
				});
			} else if (entry.mode === "hitl") {
				yield* pithosRun(pithos, config, "pithos task heartbeat", [
					"task",
					"heartbeat",
					"--run",
					entry.runId,
				]);
			}
		}
		const entries = yield* registry.list;
		if (!entries.some((entry) => entry.agent === "pandora")) {
			const runId = yield* ids.nextRunId;
			const sessionId = yield* ids.nextSessionId;
			yield* pithosRun(pithos, config, "pithos run upsert", [
				"run",
				"upsert",
				"--agent",
				"pandora",
				"--mode",
				"hitl",
				"--scope",
				"global",
				"--cwd",
				config.home,
				"--session-id",
				sessionId,
				"--run",
				runId,
			]);
			const launched = yield* spawner
				.launchAgent({
					agent: "pandora",
					mode: "hitl",
					runId,
					sessionId,
					scopeId: "global",
					cwd: config.home,
				})
				.pipe(
					Effect.catchAll((error) =>
						cleanupRun(pithos, config, runId, "launch_failed").pipe(
							Effect.zipRight(Effect.fail(error)),
						),
					),
				);
			const tmuxTarget = launched.hitl?.tmuxTarget;
			if (tmuxTarget === undefined) {
				yield* cleanupRun(pithos, config, runId, "launch_failed");
				yield* Effect.fail(
					new PdxError({ code: "PROCESS_ERROR", message: "pandora launch missing tmux target" }),
				);
			} else {
				yield* registry.upsert({
					runId,
					agent: "pandora",
					mode: "hitl",
					scopeId: "global",
					state: "live",
					logicalName: launched.logicalName,
					tmuxTarget,
				});
			}
			yield* log.write({
				level: "info",
				span: "pdx.reconcile",
				msg: "spawned pandora",
				data: { run_id: runId },
			});
		}
	});

export const runDaemon = (config: PdxConfig, maxAfk: number, intervalSeconds: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const pithos = yield* PithosClient;
		const log = yield* SupervisorLog;
		yield* fs.mkdir(config.runsDir);
		yield* log.write({ level: "info", span: "pdx.daemon", msg: "daemon starting" });
		yield* pithosRun(pithos, config, "pithos scope upsert", [
			"scope",
			"upsert",
			"--kind",
			"global",
		]);
		yield* pithosRun(pithos, config, "pithos run upsert", [
			"run",
			"upsert",
			"--agent",
			"pdx",
			"--mode",
			"afk",
			"--scope",
			"global",
			"--cwd",
			config.home,
			"--session-id",
			DAEMON_TARGET,
			"--run",
			PDX_SYSTEM_RUN_ID,
		]);
		const registry = yield* Registry;
		const tmux = yield* Tmux;
		for (const session of yield* tmux.lsSessions()) {
			if (session.startsWith("pdx--") && session !== DAEMON_TARGET) {
				yield* tmux
					.killSession(session)
					.pipe(
						Effect.catchAll((error) =>
							isMissingTmuxSessionError(error) ? Effect.void : Effect.fail(error),
						),
					);
				yield* confirmTmuxGone(tmux, session);
			}
		}
		yield* reconcileTick(config);
		const loop = yield* reconcileTick(config).pipe(
			Effect.repeat(Schedule.spaced(`${intervalSeconds} seconds`)),
			Effect.fork,
		);
		const shutdown = yield* Deferred.make<void, never>();
		const stop = Effect.gen(function* () {
			yield* log.write({ level: "info", span: "pdx.daemon", msg: "daemon stopping" });
			yield* Fiber.interrupt(loop);
			for (const entry of yield* registry.list) {
				if (entry.tmuxTarget !== undefined) {
					yield* tmux
						.killSession(entry.tmuxTarget)
						.pipe(
							Effect.catchAll((error) =>
								isMissingTmuxSessionError(error) ? Effect.void : Effect.fail(error),
							),
						);
					yield* confirmTmuxGone(tmux, entry.tmuxTarget);
				}
				yield* cleanupRun(pithos, config, entry.runId, "pdx_close");
				yield* registry.remove(entry.runId);
			}
			yield* cleanupRun(pithos, config, PDX_SYSTEM_RUN_ID, "pdx_close");
			yield* Deferred.succeed(shutdown, undefined);
			return { ok: true, data: { stopped: true } } as const;
		});
		const handle = yield* listenIpc(config.socketPath, (request) => {
			if (request.kind === "ping") return Effect.succeed({ ok: true, data: { ready: true } });
			if (request.kind === "status")
				return registry.list.pipe(
					Effect.map(
						(entries) =>
							({
								ok: true,
								data: { daemon: "running", max_afk: maxAfk, registry_entries: entries },
							}) as const,
					),
				);
			return stop;
		});
		yield* log.write({ level: "info", span: "pdx.daemon", msg: "daemon ready" });
		return { ...handle, shutdown: Deferred.await(shutdown) };
	});
