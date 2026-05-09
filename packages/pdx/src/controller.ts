import { Deferred, Effect } from "effect";
import { requestIpc, listenIpc } from "./ipc-socket.js";
import type { IpcResponse } from "./ipc.js";
import { PdxError } from "./errors.js";
import type { PdxConfig } from "./config.js";
import { FileSystem, PithosClient, SupervisorLog, Tmux } from "./services.js";

export const DAEMON_TARGET = "pdx--daemon";
export const PDX_SYSTEM_RUN_ID = "run_pdx_system";

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

export const openPdx = (config: PdxConfig) =>
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
		yield* pithos.run(["init"]).pipe(Effect.flatMap((result) => requireOk("pithos init", result)));
		yield* fs.mkdir(config.runsDir);
		yield* tmux.newSession({
			target: DAEMON_TARGET,
			cwd: config.home,
			command: [process.execPath, config.daemonEntrypoint, "daemon", "--home", config.home],
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

export const runDaemon = (config: PdxConfig) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const pithos = yield* PithosClient;
		const log = yield* SupervisorLog;
		yield* fs.mkdir(config.runsDir);
		yield* log.write({ level: "info", span: "pdx.daemon", msg: "daemon starting" });
		yield* pithos
			.run(["scope", "upsert", "--kind", "global"])
			.pipe(Effect.flatMap((result) => requireOk("pithos scope upsert", result)));
		yield* pithos
			.run([
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
			])
			.pipe(Effect.flatMap((result) => requireOk("pithos run upsert", result)));
		const shutdown = yield* Deferred.make<void, never>();
		const stop = Effect.gen(function* () {
			yield* log.write({ level: "info", span: "pdx.daemon", msg: "daemon stopping" });
			yield* pithos
				.run(["run", "cleanup", "--run", PDX_SYSTEM_RUN_ID, "--reason", "pdx_close"])
				.pipe(Effect.flatMap((result) => requireOk("pithos run cleanup", result)));
			yield* Deferred.succeed(shutdown, undefined);
			return { ok: true, data: { stopped: true } } as const;
		});
		const handle = yield* listenIpc(config.socketPath, (request) => {
			if (request.kind === "ping") return Effect.succeed({ ok: true, data: { ready: true } });
			if (request.kind === "status")
				return Effect.succeed({ ok: true, data: { daemon: "running" } });
			return stop;
		});
		yield* log.write({ level: "info", span: "pdx.daemon", msg: "daemon ready" });
		return { ...handle, shutdown: Deferred.await(shutdown) };
	});
