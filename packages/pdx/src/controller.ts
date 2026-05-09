import { Deferred, Effect } from "effect";
import { requestIpc, listenIpc } from "./ipc-socket.js";
import type { IpcResponse } from "./ipc.js";
import { PdxError } from "./errors.js";
import type { PdxConfig } from "./config.js";
import { FileSystem, PithosClient, SupervisorLog, Tmux } from "./services.js";

export const DAEMON_TARGET = "pdx--daemon";
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

export const openPdx = (config: PdxConfig, maxAfk: number) =>
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

const readDaemonMaxAfk = (config: PdxConfig, running: boolean, fallback: number) => {
	if (!running) return Effect.succeed(fallback);
	return requestIpc(config.socketPath, { kind: "status" }).pipe(
		Effect.flatMap((response) => {
			if (!response.ok) {
				return Effect.fail(
					new PdxError({ code: "IPC_ERROR", message: response.error ?? "daemon status failed" }),
				);
			}
			const value = response.data?.max_afk;
			return typeof value === "number"
				? Effect.succeed(value)
				: Effect.fail(
						new PdxError({ code: "IPC_ERROR", message: "daemon status missing max_afk" }),
					);
		}),
	);
};

export const statusPdx = (config: PdxConfig, maxAfk: number) =>
	Effect.gen(function* () {
		const tmux = yield* Tmux;
		const fs = yield* FileSystem;
		const pithos = yield* PithosClient;
		const running = yield* tmux.hasSession(DAEMON_TARGET);
		const daemonMaxAfk = yield* readDaemonMaxAfk(config, running, maxAfk);
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
			registry: { entries: [] },
			queue,
			caps: { max_afk: daemonMaxAfk, afk_used: 0 },
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

export const runDaemon = (config: PdxConfig, maxAfk: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const pithos = yield* PithosClient;
		const log = yield* SupervisorLog;
		yield* fs.mkdir(config.runsDir);
		yield* log.write({ level: "info", span: "pdx.daemon", msg: "daemon starting" });
		yield* pithos
			.run(["scope", "upsert", "--kind", "global"], { env: pithosEnv(config) })
			.pipe(Effect.flatMap((result) => requireOk("pithos scope upsert", result)));
		yield* pithos
			.run(
				[
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
				],
				{ env: pithosEnv(config) },
			)
			.pipe(Effect.flatMap((result) => requireOk("pithos run upsert", result)));
		const shutdown = yield* Deferred.make<void, never>();
		const stop = Effect.gen(function* () {
			yield* log.write({ level: "info", span: "pdx.daemon", msg: "daemon stopping" });
			yield* pithos
				.run(["run", "cleanup", "--run", PDX_SYSTEM_RUN_ID, "--reason", "pdx_close"], {
					env: pithosEnv(config),
				})
				.pipe(Effect.flatMap((result) => requireOk("pithos run cleanup", result)));
			yield* Deferred.succeed(shutdown, undefined);
			return { ok: true, data: { stopped: true } } as const;
		});
		const handle = yield* listenIpc(config.socketPath, (request) => {
			if (request.kind === "ping") return Effect.succeed({ ok: true, data: { ready: true } });
			if (request.kind === "status")
				return Effect.succeed({ ok: true, data: { daemon: "running", max_afk: maxAfk } });
			return stop;
		});
		yield* log.write({ level: "info", span: "pdx.daemon", msg: "daemon ready" });
		return { ...handle, shutdown: Deferred.await(shutdown) };
	});
