import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { parsePdxConfig } from "../src/config.js";
import { parsePdxArgs } from "../src/args.js";
import { PdxError } from "../src/errors.js";
import { parseIpcRequest } from "../src/ipc.js";
import { listenIpc, requestIpc } from "../src/ipc-socket.js";
import { makeSupervisorLog } from "../src/log.js";
import {
	Clock,
	FileSystem,
	Ids,
	makeRegistry,
	PithosClient,
	Process,
	Registry,
	Spawner,
	SupervisorLog,
	Tmux,
	type PithosClientService,
	type RegistryService,
} from "../src/services.js";
import { FileSystemLive } from "../src/live.js";
import { makeTmux } from "../src/tmux.js";
import {
	DAEMON_TARGET,
	PANDORA_TARGET,
	logsShowPdx,
	openPdx,
	PDX_SYSTEM_RUN_ID,
	handleKillRequest,
	isAfkAlive,
	reconcileTick,
	runDaemon,
	statusPdx,
} from "../src/controller.js";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.runPromise(effect as Effect.Effect<A, E, never>);

const configInput = (home: string | undefined, envHome: string | undefined) => ({
	home,
	envHome,
	daemonEntrypoint: "/tmp/pdx-dev",
});

const parseConfig = (home: string, envHome = "/tmp/user-home") =>
	run(parsePdxConfig(configInput(home, envHome)));

interface ReadyTaskInput {
	readonly scope_id: string;
	readonly capability: string;
	readonly scope_kind?: "global" | "repo" | "worktree";
	readonly canonical_path?: string | null;
}

const makePithos = (
	calls: string[] = [],
	ready: readonly ReadyTaskInput[] = [],
	overrides: Partial<PithosClientService> = {},
) => {
	const base: PithosClientService = {
		init: () => Effect.sync(() => calls.push("init")),
		scopeUpsert: (input) => Effect.sync(() => calls.push(`scopeUpsert:${input.kind}`)),
		runUpsert: (input) =>
			Effect.sync(() => calls.push(`runUpsert:${input.agent}:${input.runId ?? "new"}`)),
		runCleanup: (input) =>
			Effect.sync(() => calls.push(`runCleanup:${input.runId}:${input.reason}`)),
		runInterrupt: (input) =>
			Effect.sync(() => {
				calls.push(`runInterrupt:${input.runId ?? input.taskId}:${input.reason}`);
				return {
					run: {
						id: input.runId ?? "run_for_task",
						agent: "greed",
						mode: "afk",
						scope_id: "scope_repo",
						status: "failed",
						task_id: null,
						session_id: "session_test",
						created_at: "2026-05-09T00:00:00.000Z",
						updated_at: "2026-05-09T00:00:00.000Z",
					},
					interruptedTask: { id: input.taskId ?? "task_held", scope_id: "scope_repo" },
				};
			}),
		runTimeout: (input) =>
			Effect.sync(() => calls.push(`runTimeout:${input.runId}:${input.reason}`)),
		runInspect: (input) =>
			Effect.succeed({
				id: input.runId,
				agent: "pandora",
				mode: "hitl",
				scope_id: "global",
				status: "running",
				task_id: null,
				session_id: "session_test",
				created_at: "2026-05-09T00:00:00.000Z",
				updated_at: "2026-05-09T00:00:00.000Z",
			}),
		activeRunForTask: () =>
			Effect.succeed({
				id: "run_for_task",
				agent: "greed",
				mode: "afk",
				scope_id: "scope_repo",
				status: "running",
				task_id: "task_held",
				session_id: "session_test",
				created_at: "2026-05-09T00:00:00.000Z",
				updated_at: "2026-05-09T00:00:00.000Z",
			}),
		taskHeartbeat: (input) => Effect.sync(() => calls.push(`taskHeartbeat:${input.runId}`)),
		taskEnqueue: (input) =>
			Effect.sync(() => calls.push(`taskEnqueue:${input.capability}:${input.title}`)),
		briefing: () =>
			Effect.succeed(
				ready.map((task) => ({
					scope_kind: task.scope_kind ?? "global",
					canonical_path: task.canonical_path ?? null,
					...task,
				})),
			),
	};
	return PithosClient.of({ ...base, ...overrides });
};

const alwaysLiveTmux = Tmux.of({
	hasSession: () => Effect.succeed(true),
	lsSessions: () => Effect.succeed([]),
	newSession: () => Effect.void,
	killSession: () => Effect.void,
	sendLiteralLine: () => Effect.void,
	pasteBuffer: () => Effect.void,
});

const alwaysLiveProcess = Process.of({
	execFile: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
	isAlive: () => Effect.succeed(true),
	kill: () => Effect.void,
});

const testLog = SupervisorLog.of({ write: (record) => Effect.succeed({ ts: "now", ...record }) });

const noopFs = FileSystem.of({
	appendFile: () => Effect.void,
	readFile: () => Effect.succeed(""),
	mkdir: () => Effect.void,
	writeFileAtomic: () => Effect.void,
	removeFile: () => Effect.void,
});

const upsertPandora = (registry: RegistryService) =>
	registry.upsert({
		runId: "run_pandora",
		agent: "pandora",
		scopeId: "global",
		mode: "hitl",
		state: "live",
		logicalName: PANDORA_TARGET,
		tmuxTarget: PANDORA_TARGET,
	});

const runSpawnTick = async (input: {
	readonly home: string;
	readonly registry: RegistryService;
	readonly pithos: PithosClientService;
	readonly launches: unknown[];
	readonly maxAfk?: number;
	readonly runId?: string;
	readonly sessionId?: string;
}) =>
	run(
		reconcileTick(await parseConfig(input.home), input.maxAfk).pipe(
			Effect.provideService(Registry, input.registry),
			Effect.provideService(PithosClient, PithosClient.of(input.pithos)),
			Effect.provideService(
				Ids,
				Ids.of({
					nextRunId: Effect.succeed(input.runId ?? "run_war"),
					nextSessionId: Effect.succeed(input.sessionId ?? "session_war"),
				}),
			),
			Effect.provideService(
				Spawner,
				Spawner.of({
					launchAgent: (launch) =>
						Effect.sync(() => {
							input.launches.push(launch);
							return launch.mode === "hitl"
								? {
										...launch,
										logicalName: `pdx--${launch.agent}`,
										hitl: { tmuxTarget: `pdx--${launch.agent}`, panePid: 1 },
									}
								: {
										...launch,
										logicalName: `pdx--${launch.agent}`,
										afk: { pid: 456, processStartTime: "now" },
									};
						}),
				}),
			),
			Effect.provideService(Tmux, alwaysLiveTmux),
			Effect.provideService(Process, alwaysLiveProcess),
			Effect.provideService(SupervisorLog, testLog),
			Effect.provideService(FileSystem, noopFs),
		),
	);

describe("pdx substrate", () => {
	it("derives config paths from home", async () => {
		const config = await parseConfig("/tmp/pdx-home");
		expect(config).toMatchObject({
			home: "/tmp/pdx-home",
			socketPath: "/tmp/pdx-home/pdx.sock",
			logPath: "/tmp/pdx-home/pdx.jsonl",
			runsDir: "/tmp/pdx-home/runs",
		});
	});

	it("uses explicit --home without HOME env", async () => {
		const config = await run(parsePdxConfig(configInput("/tmp/pdx-home", undefined)));
		expect(config.home).toBe("/tmp/pdx-home");
	});

	it("fails config parse when --home and HOME env are both missing", async () => {
		await expect(run(parsePdxConfig({ daemonEntrypoint: "/tmp/pdx-dev" }))).rejects.toThrow(
			/missing required home/,
		);
	});

	it("parses pure CLI args and rejects unknown/extra values", async () => {
		const parsed = await run(
			parsePdxArgs([
				"--home",
				"/tmp/pdx-home",
				"logs",
				"show",
				"--limit",
				"10",
				"--all",
				"--json",
				"--since",
				"1h",
			]),
		);
		expect(parsed).toMatchObject({
			home: "/tmp/pdx-home",
			command: {
				kind: "logs-show",
				limit: 10,
				all: true,
				since: "1h",
			},
		});

		await expect(run(parsePdxArgs(["open", "extra"]))).rejects.toThrow(/positional arguments/);
		await expect(run(parsePdxArgs(["open", "--unknown"]))).rejects.toThrow(/Unknown option/);
		await expect(run(parsePdxArgs(["open", "--limit", "10"]))).rejects.toThrow(/logs options/);
		await expect(
			run(parsePdxArgs(["open", "--max-afk", "8", "--interval-seconds", "5"])),
		).resolves.toMatchObject({
			command: { kind: "open" },
		});
		await expect(
			run(parsePdxArgs(["daemon", "--interval-seconds", "5", "--max-afk", "6"])),
		).resolves.toMatchObject({
			command: { kind: "daemon" },
		});
		await expect(run(parsePdxArgs(["close", "--interval-seconds", "99"]))).rejects.toThrow(
			/does not take command options/,
		);
		await expect(run(parsePdxArgs(["daemon", "--json"]))).rejects.toThrow(/does not take --json/);
		await expect(run(parsePdxArgs(["status", "--json"]))).resolves.toMatchObject({
			command: { kind: "status" },
		});
		await expect(run(parsePdxArgs(["status", "--max-afk", "7"]))).rejects.toThrow(
			/afk timing options/,
		);
		await expect(run(parsePdxArgs(["logs", "show", "--max-afk", "9"]))).rejects.toThrow(
			/afk timing options/,
		);
	});

	it("constructs tmux argv and sends literal line as text then enter", async () => {
		const calls: { file: string; args: readonly string[]; cwd: string | undefined }[] = [];
		const process = Process.of({
			execFile: (file, args, options) =>
				Effect.sync(() => {
					calls.push({ file, args, cwd: options?.cwd });
					return { exitCode: 0, stdout: "", stderr: "" };
				}),
			isAlive: () => Effect.succeed(true),
			kill: () => Effect.void,
		});
		const tmux = await run(makeTmux.pipe(Effect.provideService(Process, process)));
		await run(tmux.sendLiteralLine("pdx--pandora", "hello; rm -rf /"));
		expect(calls).toEqual([
			{
				file: "tmux",
				args: ["send-keys", "-t", "pdx--pandora", "-l", "--", "hello; rm -rf /"],
				cwd: undefined,
			},
			{ file: "tmux", args: ["send-keys", "-t", "pdx--pandora", "Enter"], cwd: undefined },
		]);
	});

	it("writes supervisor logs with required fields", async () => {
		const writes: string[] = [];
		const fs = FileSystem.of({
			appendFile: (_path, content) => Effect.sync(() => writes.push(content)),
			readFile: () => Effect.succeed(""),
			mkdir: () => Effect.void,
			writeFileAtomic: () => Effect.void,
			removeFile: () => Effect.void,
		});
		const clock = Clock.of({ nowIso: Effect.succeed("2026-05-09T00:00:00.000Z") });
		const log = await run(
			makeSupervisorLog("/tmp/pdx.jsonl").pipe(
				Effect.provideService(FileSystem, fs),
				Effect.provideService(Clock, clock),
			),
		);
		await run(log.write({ level: "info", span: "test-span", msg: "hello" }));
		expect(JSON.parse(writes[0] ?? "{}")).toEqual({
			ts: "2026-05-09T00:00:00.000Z",
			level: "info",
			span: "test-span",
			msg: "hello",
		});
	});

	it("rejects malformed and unknown IPC requests loudly", async () => {
		await expect(run(parseIpcRequest("{"))).rejects.toThrow(/Malformed IPC request JSON/);
		await expect(run(parseIpcRequest(JSON.stringify({ kind: "kill" })))).rejects.toThrow(
			/Invalid IPC request/,
		);
		await expect(run(parseIpcRequest(JSON.stringify({ kind: "ping" })))).resolves.toEqual({
			kind: "ping",
		});
	});

	it("open rejects when daemon tmux session already exists", async () => {
		const tmux = Tmux.of({
			hasSession: () => Effect.succeed(true),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: () => Effect.void,
			writeFileAtomic: () => Effect.void,
			removeFile: () => Effect.void,
		});
		const pithos = makePithos();
		await expect(
			run(
				openPdx(await parseConfig("/tmp/pdx-home"), 4, 5).pipe(
					Effect.provideService(Tmux, tmux),
					Effect.provideService(FileSystem, fs),
					Effect.provideService(PithosClient, pithos),
				),
			),
		).rejects.toThrow(`${DAEMON_TARGET} already exists`);
	});

	it("open starts daemon tmux session with configured entrypoint", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const config = await parseConfig(home);
		let commandInput:
			| { readonly target: string; readonly cwd: string; readonly command: readonly string[] }
			| undefined;
		const tmux = Tmux.of({
			hasSession: () => Effect.succeed(false),
			lsSessions: () => Effect.succeed([]),
			newSession: (input) =>
				Effect.sync(() => {
					commandInput = input;
				}),
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: () => Effect.void,
			writeFileAtomic: () => Effect.void,
			removeFile: () => Effect.void,
		});
		const pithos = makePithos();
		const server = await run(
			listenIpc(config.socketPath, () => Effect.succeed({ ok: true, data: { ready: true } })),
		);
		try {
			await run(
				openPdx(config, 4, 5).pipe(
					Effect.provideService(Tmux, tmux),
					Effect.provideService(FileSystem, fs),
					Effect.provideService(PithosClient, pithos),
				),
			);
		} finally {
			await run(server.close);
		}
		expect(commandInput).toEqual({
			target: DAEMON_TARGET,
			cwd: config.home,
			command: [
				config.daemonEntrypoint,
				"daemon",
				"--home",
				config.home,
				"--max-afk",
				"4",
				"--interval-seconds",
				"5",
			],
		});
	});
	it("daemon startup creates runs dir, system run, Pandora singleton, and excludes pdx from caps", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const mkdirs: string[] = [];
		const pithosCalls: string[] = [];
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: (path) => Effect.sync(() => mkdirs.push(path)),
			writeFileAtomic: () => Effect.void,
			removeFile: () => Effect.void,
		});
		const pithos = makePithos(pithosCalls, [
			{ scope_id: "global", capability: "triage", scope_kind: "global", canonical_path: null },
		]);
		const log = SupervisorLog.of({ write: (record) => Effect.succeed({ ts: "now", ...record }) });
		const registry = await run(makeRegistry);
		const runIds = ["run_pandora_1", "run_toil_1"];
		const sessionIds = ["session_pandora_1", "session_toil_1"];
		const ids = Ids.of({
			nextRunId: Effect.sync(() => runIds.shift() ?? "run_unexpected"),
			nextSessionId: Effect.sync(() => sessionIds.shift() ?? "session_unexpected"),
		});
		const spawner = Spawner.of({
			launchAgent: (input) =>
				Effect.succeed(
					input.agent === "pandora"
						? {
								...input,
								logicalName: PANDORA_TARGET,
								hitl: { tmuxTarget: PANDORA_TARGET, panePid: 123 },
							}
						: {
								...input,
								logicalName: "pdx--toil",
								afk: { pid: 123, processStartTime: "now" },
							},
				),
		});
		const tmux = Tmux.of({
			hasSession: () => Effect.succeed(true),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		const process = Process.of({
			execFile: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
			isAlive: () => Effect.succeed(true),
			kill: () => Effect.void,
		});
		const config = await parseConfig(home);
		const handle = await run(
			runDaemon(config, 1, 5).pipe(
				Effect.provideService(FileSystem, fs),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(SupervisorLog, log),
				Effect.provideService(Registry, registry),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
				Effect.provideService(Process, process),
			),
		);
		await run(handle.close);
		expect(mkdirs).toEqual([`${home}/runs`]);
		expect(pithosCalls).toContain("scopeUpsert:global");
		expect(pithosCalls).toContain(`runUpsert:pdx:${PDX_SYSTEM_RUN_ID}`);
		expect(pithosCalls).toContain("runUpsert:pandora:run_pandora_1");
		expect(pithosCalls).toContain("runUpsert:toil:run_toil_1");
		expect((await run(registry.list)).map((entry) => entry.agent)).not.toContain("pdx");
	});

	it("daemon stop replies after cleanup and closes the IPC socket explicitly", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const pithosCalls: string[] = [];
		const removes: string[] = [];
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: () => Effect.void,
			writeFileAtomic: () => Effect.void,
			removeFile: (path) => Effect.sync(() => removes.push(path)),
		});
		const pithos = makePithos(pithosCalls);
		const log = SupervisorLog.of({ write: (record) => Effect.succeed({ ts: "now", ...record }) });
		const registry = await run(makeRegistry);
		const ids = Ids.of({
			nextRunId: Effect.succeed("run_pandora_1"),
			nextSessionId: Effect.succeed("session_pandora_1"),
		});
		const spawner = Spawner.of({
			launchAgent: (input) =>
				Effect.succeed({
					...input,
					logicalName: PANDORA_TARGET,
					hitl: { tmuxTarget: PANDORA_TARGET, panePid: 123 },
				}),
		});
		const killed: string[] = [];
		const processKills: string[] = [];
		const process = Process.of({
			execFile: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
			isAlive: (pid) => Effect.succeed(!processKills.includes(`${pid}:SIGTERM`)),
			kill: (pid, signal) => Effect.sync(() => processKills.push(`${pid}:${signal}`)),
		});
		const tmux = Tmux.of({
			hasSession: (target) => Effect.succeed(!killed.includes(target)),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: (target) => Effect.sync(() => killed.push(target)),
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		const config = await parseConfig(home);
		const handle = await run(
			runDaemon(config, 4, 5).pipe(
				Effect.provideService(FileSystem, fs),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(SupervisorLog, log),
				Effect.provideService(Registry, registry),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
				Effect.provideService(Process, process),
			),
		);
		await run(
			registry.upsert({
				runId: "run_afk_close",
				agent: "war",
				scopeId: "scope_repo",
				mode: "afk",
				state: "live",
				logicalName: "pdx--war",
				pid: 456,
			}),
		);
		const response = await run(requestIpc(config.socketPath, { kind: "stop" }));
		await run(handle.shutdown);
		await run(handle.close);
		expect(response).toEqual({ ok: true, data: { stopped: true } });
		expect(processKills).toContain("456:SIGTERM");
		expect(pithosCalls).toContain("runCleanup:run_afk_close:pdx_close");
		expect(removes).toContain(`${config.runsDir}/run_afk_close.pid`);
		expect(pithosCalls.at(-1)).toEqual(`runCleanup:${PDX_SYSTEM_RUN_ID}:pdx_close`);
		expect(existsSync(config.socketPath)).toBe(false);
	});

	it("status returns required top-level keys when daemon is down", async () => {
		const tmux = Tmux.of({
			hasSession: () => Effect.succeed(false),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		const pithosCalls: string[] = [];
		const pithos = makePithos(pithosCalls, [{ scope_id: "global", capability: "escalate" }]);
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: () => Effect.void,
			writeFileAtomic: () => Effect.void,
			removeFile: () => Effect.void,
		});
		const status = await run(
			statusPdx(await parseConfig("/tmp/pdx-home"), 7).pipe(
				Effect.provideService(Tmux, tmux),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(FileSystem, fs),
			),
		);
		expect(pithosCalls).toEqual(["init"]);
		expect(status).toEqual({
			daemon: { running: false, target: DAEMON_TARGET, socket_path: "/tmp/pdx-home/pdx.sock" },
			registry: { entries: [] },
			queue: { claimable: 1, by_scope_capability: { global: { escalate: 1 } } },
			caps: { max_afk: 7, afk_used: 0 },
		});
	});

	it("status fails loudly on tmux status errors", async () => {
		const tmux = Tmux.of({
			hasSession: () =>
				Effect.fail(new PdxError({ code: "PROCESS_ERROR", message: "tmux exploded" })),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		const pithos = makePithos();
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: () => Effect.void,
			writeFileAtomic: () => Effect.void,
			removeFile: () => Effect.void,
		});
		await expect(
			run(
				statusPdx(await parseConfig("/tmp/pdx-home"), 4).pipe(
					Effect.provideService(Tmux, tmux),
					Effect.provideService(PithosClient, pithos),
					Effect.provideService(FileSystem, fs),
				),
			),
		).rejects.toThrow("tmux exploded");
	});

	it("logs show preserves raw JSONL and applies default limit, explicit limit, all, and since", async () => {
		const lines = Array.from({ length: 101 }, (_, index) =>
			JSON.stringify({
				ts: new Date(Date.UTC(2026, 4, 9, 0, index, 0)).toISOString(),
				level: "info",
				span: "test",
				msg: `line-${index}`,
			}),
		);
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(`${lines.join("\n")}\n`),
			mkdir: () => Effect.void,
			writeFileAtomic: () => Effect.void,
			removeFile: () => Effect.void,
		});
		const config = await parseConfig("/tmp/pdx-home");
		const defaultOutput = await run(
			logsShowPdx(config, { limit: undefined, all: false, since: undefined }).pipe(
				Effect.provideService(FileSystem, fs),
			),
		);
		expect(defaultOutput).toBe(`${lines.slice(1).join("\n")}\n`);
		const sinceClock = Clock.of({ nowIso: Effect.succeed("2026-05-09T01:40:00.000Z") });
		const limitOutput = await run(
			logsShowPdx(config, { limit: 2, all: false, since: undefined }).pipe(
				Effect.provideService(FileSystem, fs),
			),
		);
		expect(limitOutput).toBe(`${lines.slice(-2).join("\n")}\n`);
		const allOutput = await run(
			logsShowPdx(config, { limit: undefined, all: true, since: undefined }).pipe(
				Effect.provideService(FileSystem, fs),
			),
		);
		expect(allOutput).toBe(`${lines.join("\n")}\n`);
		const sinceOutput = await run(
			logsShowPdx(config, {
				limit: undefined,
				all: true,
				since: new Date(Date.UTC(2026, 4, 9, 1, 39, 0)).toISOString(),
			}).pipe(Effect.provideService(FileSystem, fs), Effect.provideService(Clock, sinceClock)),
		);
		expect(sinceOutput).toBe(`${lines.slice(99).join("\n")}\n`);
	});

	it("logs show accepts documented since forms and rejects malformed input and corrupt JSONL", async () => {
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			level: "info",
			span: "test",
			msg: "line",
		});
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(`${line}\n`),
			mkdir: () => Effect.void,
			writeFileAtomic: () => Effect.void,
			removeFile: () => Effect.void,
		});
		const config = await parseConfig("/tmp/pdx-home");
		const logsClock = Clock.of({ nowIso: Effect.succeed("2026-05-09T01:40:00.000Z") });
		for (const since of [
			"10m",
			"1h",
			"2d",
			"1w",
			"today",
			"yesterday",
			"2026-05-09T00:00:00.000Z",
		]) {
			await expect(
				run(
					logsShowPdx(config, { limit: undefined, all: true, since }).pipe(
						Effect.provideService(FileSystem, fs),
						Effect.provideService(Clock, logsClock),
					),
				),
			).resolves.toEqual(expect.any(String));
		}
		await expect(
			run(
				logsShowPdx(config, { limit: undefined, all: true, since: "soon" }).pipe(
					Effect.provideService(FileSystem, fs),
					Effect.provideService(Clock, logsClock),
				),
			),
		).rejects.toThrow("invalid --since value");
		const corruptFs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed("{\n"),
			mkdir: () => Effect.void,
			writeFileAtomic: () => Effect.void,
			removeFile: () => Effect.void,
		});
		await expect(
			run(
				logsShowPdx(config, { limit: undefined, all: true, since: undefined }).pipe(
					Effect.provideService(FileSystem, corruptFs),
				),
			),
		).rejects.toThrow("corrupt supervisor log JSONL");
		const blankLineFs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(`${line}\n\n${line}\n`),
			mkdir: () => Effect.void,
			writeFileAtomic: () => Effect.void,
			removeFile: () => Effect.void,
		});
		await expect(
			run(
				logsShowPdx(config, { limit: undefined, all: true, since: undefined }).pipe(
					Effect.provideService(FileSystem, blankLineFs),
				),
			),
		).rejects.toThrow("corrupt supervisor log JSONL");
	});

	it("AFK liveness probe delegates to process kill-zero boundary", async () => {
		const liveProcess = Process.of({
			execFile: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
			isAlive: () => Effect.succeed(true),
			kill: () => Effect.void,
		});
		const deadProcess = Process.of({
			execFile: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
			isAlive: () => Effect.succeed(false),
			kill: () => Effect.void,
		});
		await expect(
			run(isAfkAlive(123).pipe(Effect.provideService(Process, liveProcess))),
		).resolves.toBe(true);
		await expect(
			run(isAfkAlive(456).pipe(Effect.provideService(Process, deadProcess))),
		).resolves.toBe(false);
	});

	it("reconcile cleans dead Pandora and respawns with a fresh run id", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const registry = await run(makeRegistry);
		await run(
			registry.upsert({
				runId: "run_old",
				agent: "pandora",
				scopeId: "global",
				mode: "hitl",
				state: "live",
				logicalName: PANDORA_TARGET,
				tmuxTarget: PANDORA_TARGET,
			}),
		);
		const pithosCalls: string[] = [];
		const pithos = makePithos(pithosCalls);
		const ids = Ids.of({
			nextRunId: Effect.succeed("run_new"),
			nextSessionId: Effect.succeed("session_new"),
		});
		const spawner = Spawner.of({
			launchAgent: (input) =>
				Effect.succeed({
					...input,
					logicalName: PANDORA_TARGET,
					hitl: { tmuxTarget: PANDORA_TARGET, panePid: 123 },
				}),
		});
		let probes = 0;
		const tmux = Tmux.of({
			hasSession: () => Effect.sync(() => ++probes > 1),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		const log = SupervisorLog.of({ write: (record) => Effect.succeed({ ts: "now", ...record }) });
		await run(
			reconcileTick(await parseConfig(home)).pipe(
				Effect.provideService(Registry, registry),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
				Effect.provideService(SupervisorLog, log),
				Effect.provideService(FileSystem, noopFs),
			),
		);
		const entries = await run(registry.list);
		expect(entries.map((entry) => entry.runId)).toEqual(["run_new"]);
		expect(pithosCalls).toContain("runCleanup:run_old:natural_death");
	});

	it("daemon kill uses interrupted run details for escalation and resource kill", async () => {
		const registry = await run(makeRegistry);
		await run(
			registry.upsert({
				runId: "run_old_owner",
				agent: "greed",
				scopeId: "scope_repo",
				mode: "afk",
				state: "live",
				logicalName: "pdx--greed-old",
				pid: 123,
			}),
		);
		await run(
			registry.upsert({
				runId: "run_new_owner",
				agent: "greed",
				scopeId: "scope_repo",
				mode: "afk",
				state: "live",
				logicalName: "pdx--greed",
				pid: 321,
			}),
		);
		const calls: string[] = [];
		const enqueues: Parameters<PithosClientService["taskEnqueue"]>[0][] = [];
		const pithos = makePithos(calls, [], {
			activeRunForTask: () =>
				Effect.succeed({
					id: "run_old_owner",
					agent: "greed",
					mode: "afk",
					scope_id: "scope_repo",
					status: "running",
					task_id: "task_held",
					session_id: "session_old",
					created_at: "2026-05-09T00:00:00.000Z",
					updated_at: "2026-05-09T00:00:00.000Z",
				}),
			runInterrupt: () =>
				Effect.succeed({
					run: {
						id: "run_new_owner",
						agent: "greed",
						mode: "afk",
						scope_id: "scope_repo",
						status: "failed",
						task_id: null,
						session_id: "session_new",
						created_at: "2026-05-09T00:00:00.000Z",
						updated_at: "2026-05-09T00:00:00.000Z",
					},
					interruptedTask: { id: "task_held", scope_id: "scope_repo" },
				}),
			taskEnqueue: (input) =>
				Effect.sync(() => {
					enqueues.push(input);
					calls.push(`taskEnqueue:${input.capability}:${input.title}`);
				}),
		});
		const kills: string[] = [];
		const process = Process.of({
			execFile: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
			isAlive: () => Effect.succeed(true),
			kill: (pid, signal) => Effect.sync(() => kills.push(`${pid}:${signal}`)),
		});
		await run(
			handleKillRequest({ run: undefined, task: "task_held", reason: "operator stop" }).pipe(
				Effect.provideService(Registry, registry),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(Process, process),
				Effect.provideService(
					Tmux,
					Tmux.of({
						hasSession: () => Effect.succeed(true),
						lsSessions: () => Effect.succeed([]),
						newSession: () => Effect.void,
						killSession: () => Effect.void,
						sendLiteralLine: () => Effect.void,
						pasteBuffer: () => Effect.void,
					}),
				),
			),
		);
		expect(kills).toEqual(["321:SIGTERM"]);
		expect(calls).toContain("taskEnqueue:escalate:Investigate interrupted task task_held");
		expect(enqueues[0]).toMatchObject({
			scope: "global",
			capability: "escalate",
			runId: PDX_SYSTEM_RUN_ID,
		});
		expect(enqueues[0]?.body).toContain("Run: run_new_owner");
		expect(enqueues[0]?.body).toContain("Task: task_held");
		expect(enqueues[0]?.body).toContain("Scope: scope_repo");
		expect(enqueues[0]?.body).toContain("Reason: operator stop");
		expect(await run(registry.list)).toContainEqual(
			expect.objectContaining({ runId: "run_new_owner", state: "terminating" }),
		);
	});

	it("daemon kill rejects non-held task with cancel guidance", async () => {
		const registry = await run(makeRegistry);
		const pithos = makePithos([], [], { activeRunForTask: () => Effect.succeed(null) });
		await expect(
			run(
				handleKillRequest({ run: undefined, task: "task_idle", reason: "stop" }).pipe(
					Effect.provideService(Registry, registry),
					Effect.provideService(PithosClient, pithos),
				),
			),
		).rejects.toThrow(/pithos task cancel/);
	});

	it("daemon kill rejects missing runs loudly", async () => {
		const registry = await run(makeRegistry);
		const pithos = makePithos([], [], {
			runInspect: () =>
				Effect.fail(new PdxError({ code: "NOT_FOUND", message: "run not found: run_missing" })),
		});
		await expect(
			run(
				handleKillRequest({ run: "run_missing", task: undefined, reason: "stop" }).pipe(
					Effect.provideService(Registry, registry),
					Effect.provideService(PithosClient, pithos),
				),
			),
		).rejects.toThrow(/run not found/);
	});

	it("daemon kill rejects terminal runs before interrupting", async () => {
		const registry = await run(makeRegistry);
		const calls: string[] = [];
		const pithos = makePithos(calls, [], {
			runInspect: () =>
				Effect.succeed({
					id: "run_done",
					agent: "greed",
					mode: "afk",
					scope_id: "scope_repo",
					status: "ended",
					task_id: null,
					session_id: "session_done",
					created_at: "2026-05-09T00:00:00.000Z",
					updated_at: "2026-05-09T00:00:00.000Z",
				}),
		});
		await expect(
			run(
				handleKillRequest({ run: "run_done", task: undefined, reason: "stop" }).pipe(
					Effect.provideService(Registry, registry),
					Effect.provideService(PithosClient, pithos),
				),
			),
		).rejects.toThrow(/terminal/);
		expect(calls).not.toContain("runInterrupt:run_done:stop");
	});

	it("kill retry keeps terminating entry until resource is gone", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const registry = await run(makeRegistry);
		await run(
			registry.upsert({
				runId: "run_pandora",
				agent: "pandora",
				scopeId: "global",
				mode: "hitl",
				state: "live",
				logicalName: PANDORA_TARGET,
				tmuxTarget: PANDORA_TARGET,
			}),
		);
		await run(
			registry.upsert({
				runId: "run_kill",
				agent: "greed",
				scopeId: "scope_repo",
				mode: "afk",
				state: "terminating",
				logicalName: "pdx--greed",
				pid: 123,
				killAttempts: 1,
			}),
		);
		const kills: string[] = [];
		let aliveProbe = 0;
		const process = Process.of({
			execFile: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
			isAlive: () => Effect.succeed(aliveProbe++ === 0),
			kill: (_pid, signal) =>
				Effect.sync(() => kills.push(signal)).pipe(
					Effect.zipRight(
						Effect.fail(new PdxError({ code: "PROCESS_ERROR", message: "kill failed" })),
					),
				),
		});
		const logs: string[] = [];
		const log = SupervisorLog.of({
			write: (record) =>
				Effect.sync(() => {
					logs.push(record.span);
					return { ts: "now", ...record };
				}),
		});
		const pithos = makePithos([]);
		const ids = Ids.of({
			nextRunId: Effect.succeed("run_unused"),
			nextSessionId: Effect.succeed("session_unused"),
		});
		const spawner = Spawner.of({
			launchAgent: () =>
				Effect.fail(new PdxError({ code: "PROCESS_ERROR", message: "unexpected launch" })),
		});
		const tmux = Tmux.of({
			hasSession: () => Effect.succeed(true),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		await run(
			reconcileTick(await parseConfig(home)).pipe(
				Effect.provideService(Registry, registry),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
				Effect.provideService(Process, process),
				Effect.provideService(SupervisorLog, log),
				Effect.provideService(FileSystem, noopFs),
			),
		);
		expect(kills).toEqual(["SIGKILL"]);
		expect(await run(registry.list)).toContainEqual(
			expect.objectContaining({ runId: "run_kill", state: "terminating" }),
		);
		await run(
			reconcileTick(await parseConfig(home)).pipe(
				Effect.provideService(Registry, registry),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
				Effect.provideService(Process, process),
				Effect.provideService(SupervisorLog, log),
				Effect.provideService(FileSystem, noopFs),
			),
		);
		expect(await run(registry.list)).toEqual([expect.objectContaining({ runId: "run_pandora" })]);
		expect(logs).toContain("pdx.kill.retry");
		expect(logs).toContain("pdx.kill");
	});

	it("reconcile spawns one non-Pandora agent in seeded order without pre-claiming", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const registry = await run(makeRegistry);
		await run(
			registry.upsert({
				runId: "run_pandora",
				agent: "pandora",
				scopeId: "global",
				mode: "hitl",
				state: "live",
				logicalName: PANDORA_TARGET,
				tmuxTarget: PANDORA_TARGET,
			}),
		);
		const pithosCalls: string[] = [];
		const pithos = makePithos(pithosCalls, [
			{ scope_id: "scope_war", capability: "execute", scope_kind: "repo", canonical_path: "/repo" },
			{
				scope_id: "scope_greed",
				capability: "design",
				scope_kind: "worktree",
				canonical_path: "/wt",
			},
			{ scope_id: "global", capability: "triage", scope_kind: "global", canonical_path: null },
		]);
		const ids = Ids.of({
			nextRunId: Effect.succeed("run_toil"),
			nextSessionId: Effect.succeed("session_toil"),
		});
		const launches: unknown[] = [];
		const spawner = Spawner.of({
			launchAgent: (input) =>
				Effect.sync(() => {
					launches.push(input);
					return { ...input, logicalName: "pdx--toil", afk: { pid: 123, processStartTime: "now" } };
				}),
		});
		const log = SupervisorLog.of({ write: (record) => Effect.succeed({ ts: "now", ...record }) });
		const tmux = Tmux.of({
			hasSession: () => Effect.succeed(true),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		await run(
			reconcileTick(await parseConfig(home)).pipe(
				Effect.provideService(Registry, registry),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
				Effect.provideService(SupervisorLog, log),
				Effect.provideService(FileSystem, noopFs),
			),
		);
		expect(pithosCalls).toContain("runUpsert:toil:run_toil");
		expect(
			pithosCalls.some(
				(call) => call.startsWith("runInterrupt") || call.startsWith("taskHeartbeat:run_toil"),
			),
		).toBe(false);
		expect(launches).toEqual([
			expect.objectContaining({
				agent: "toil",
				mode: "afk",
				runId: "run_toil",
				sessionId: "session_toil",
				scopeId: "global",
				cwd: home,
			}),
		]);
		expect(await run(registry.list)).toContainEqual(
			expect.objectContaining({ runId: "run_toil", agent: "toil", state: "live", pid: 123 }),
		);
	});

	it.each(["launching", "live", "terminating"] as const)(
		"per-agent/scope cap blocks spawn while existing entry is %s",
		async (state) => {
			const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
			const registry = await run(makeRegistry);
			await run(upsertPandora(registry));
			await run(
				registry.upsert({
					runId: "run_existing",
					agent: "war",
					scopeId: "scope_repo",
					mode: "afk",
					state,
					logicalName: "pdx--war-existing",
					pid: 123,
				}),
			);
			const calls: string[] = [];
			const launches: unknown[] = [];
			await runSpawnTick({
				home,
				registry,
				pithos: makePithos(calls, [
					{
						scope_id: "scope_repo",
						capability: "execute",
						scope_kind: "repo",
						canonical_path: "/repo",
					},
				]),
				launches,
			});
			expect(launches).toEqual([]);
			expect(calls).not.toContain("runUpsert:war:run_war");
		},
	);

	it.each(["launching", "live", "terminating"] as const)(
		"global AFK cap blocks non-Pandora spawns while existing entry is %s",
		async (state) => {
			const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
			const registry = await run(makeRegistry);
			await run(upsertPandora(registry));
			await run(
				registry.upsert({
					runId: "run_toil_existing",
					agent: "toil",
					scopeId: "scope_other",
					mode: "afk",
					state,
					logicalName: "pdx--toil-existing",
					pid: 123,
				}),
			);
			const calls: string[] = [];
			const launches: unknown[] = [];
			await runSpawnTick({
				home,
				registry,
				maxAfk: 1,
				pithos: makePithos(calls, [
					{
						scope_id: "scope_repo",
						capability: "execute",
						scope_kind: "repo",
						canonical_path: "/repo",
					},
				]),
				launches,
			});
			expect(launches).toEqual([]);
			expect(calls).not.toContain("runUpsert:war:run_war");
		},
	);

	it("global AFK cap releases after entry removal", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const registry = await run(makeRegistry);
		await run(upsertPandora(registry));
		await run(
			registry.upsert({
				runId: "run_toil_existing",
				agent: "toil",
				scopeId: "scope_other",
				mode: "afk",
				state: "live",
				logicalName: "pdx--toil-existing",
				pid: 123,
			}),
		);
		await run(registry.remove("run_toil_existing"));
		const launches: unknown[] = [];
		await runSpawnTick({
			home,
			registry,
			maxAfk: 1,
			pithos: makePithos(
				[],
				[
					{
						scope_id: "scope_repo",
						capability: "execute",
						scope_kind: "repo",
						canonical_path: "/repo",
					},
				],
			),
			launches,
		});
		expect(launches).toEqual([expect.objectContaining({ agent: "war", scopeId: "scope_repo" })]);
	});

	it("Pandora does not consume global AFK capacity", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const registry = await run(makeRegistry);
		await run(upsertPandora(registry));
		const launches: unknown[] = [];
		await runSpawnTick({
			home,
			registry,
			maxAfk: 1,
			runId: "run_toil",
			sessionId: "session_toil",
			pithos: makePithos(
				[],
				[{ scope_id: "global", capability: "triage", scope_kind: "global", canonical_path: null }],
			),
			launches,
		});
		expect(launches).toEqual([expect.objectContaining({ agent: "toil" })]);
	});

	it("derives non-Pandora cwd from repo and worktree scopes", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const registry = await run(makeRegistry);
		await run(
			registry.upsert({
				runId: "run_pandora",
				agent: "pandora",
				scopeId: "global",
				mode: "hitl",
				state: "live",
				logicalName: PANDORA_TARGET,
				tmuxTarget: PANDORA_TARGET,
			}),
		);
		const pithos = makePithos(
			[],
			[
				{
					scope_id: "scope_greed",
					capability: "design",
					scope_kind: "worktree",
					canonical_path: "/wt",
				},
			],
		);
		const ids = Ids.of({
			nextRunId: Effect.succeed("run_greed"),
			nextSessionId: Effect.succeed("session_greed"),
		});
		const launches: unknown[] = [];
		const spawner = Spawner.of({
			launchAgent: (input) =>
				Effect.sync(() => {
					launches.push(input);
					return {
						...input,
						logicalName: "pdx--greed",
						hitl: { tmuxTarget: "pdx--greed", panePid: 1 },
					};
				}),
		});
		const log = SupervisorLog.of({ write: (record) => Effect.succeed({ ts: "now", ...record }) });
		const tmux = Tmux.of({
			hasSession: () => Effect.succeed(true),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		await run(
			reconcileTick(await parseConfig(home)).pipe(
				Effect.provideService(Registry, registry),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
				Effect.provideService(SupervisorLog, log),
				Effect.provideService(FileSystem, noopFs),
			),
		);
		expect(launches).toEqual([
			expect.objectContaining({ agent: "greed", cwd: "/wt", scopeId: "scope_greed" }),
		]);
	});

	it("spawns War for repo execute work with repo cwd", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const registry = await run(makeRegistry);
		await run(
			registry.upsert({
				runId: "run_pandora",
				agent: "pandora",
				scopeId: "global",
				mode: "hitl",
				state: "live",
				logicalName: PANDORA_TARGET,
				tmuxTarget: PANDORA_TARGET,
			}),
		);
		const pithos = makePithos(
			[],
			[
				{
					scope_id: "scope_repo",
					capability: "execute",
					scope_kind: "repo",
					canonical_path: "/repo",
				},
			],
		);
		const ids = Ids.of({
			nextRunId: Effect.succeed("run_war"),
			nextSessionId: Effect.succeed("session_war"),
		});
		const launches: unknown[] = [];
		const spawner = Spawner.of({
			launchAgent: (input) =>
				Effect.sync(() => {
					launches.push(input);
					return { ...input, logicalName: "pdx--war", afk: { pid: 456, processStartTime: "now" } };
				}),
		});
		const log = SupervisorLog.of({ write: (record) => Effect.succeed({ ts: "now", ...record }) });
		const tmux = Tmux.of({
			hasSession: () => Effect.succeed(true),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		await run(
			reconcileTick(await parseConfig(home)).pipe(
				Effect.provideService(Registry, registry),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
				Effect.provideService(SupervisorLog, log),
				Effect.provideService(FileSystem, noopFs),
			),
		);
		expect(launches).toEqual([
			expect.objectContaining({
				agent: "war",
				mode: "afk",
				runId: "run_war",
				sessionId: "session_war",
				scopeId: "scope_repo",
				cwd: "/repo",
			}),
		]);
	});

	it("AFK launch writes pidfile and cleanup removes it after Pithos cleanup", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const registry = await run(makeRegistry);
		await run(upsertPandora(registry));
		const writes: string[] = [];
		const removes: string[] = [];
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: () => Effect.void,
			writeFileAtomic: (path, content) => Effect.sync(() => writes.push(`${path}:${content}`)),
			removeFile: (path) => Effect.sync(() => removes.push(path)),
		});
		const pithos = makePithos(
			[],
			[
				{
					scope_id: "scope_repo",
					capability: "execute",
					scope_kind: "repo",
					canonical_path: "/repo",
				},
			],
		);
		const ids = Ids.of({
			nextRunId: Effect.succeed("run_war"),
			nextSessionId: Effect.succeed("session_war"),
		});
		const spawner = Spawner.of({
			launchAgent: (input) =>
				Effect.succeed({
					...input,
					logicalName: "pdx--war",
					afk: { pid: 456, processStartTime: "now" },
				}),
		});
		const process = Process.of({
			execFile: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
			isAlive: () => Effect.succeed(true),
			kill: () => Effect.void,
		});
		const tmux = Tmux.of({
			hasSession: () => Effect.succeed(true),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		const config = await parseConfig(home);
		await run(
			reconcileTick(config).pipe(
				Effect.provideService(Registry, registry),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
				Effect.provideService(Process, process),
				Effect.provideService(SupervisorLog, testLog),
				Effect.provideService(FileSystem, fs),
			),
		);
		expect(writes).toEqual([`${config.runsDir}/run_war.pid:456\n`]);
		await run(
			reconcileTick(config).pipe(
				Effect.provideService(Registry, registry),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
				Effect.provideService(
					Process,
					Process.of({ ...process, isAlive: () => Effect.succeed(false) }),
				),
				Effect.provideService(SupervisorLog, testLog),
				Effect.provideService(FileSystem, fs),
			),
		);
		expect(removes).toContain(`${config.runsDir}/run_war.pid`);
	});

	it("HITL launch writes no pidfile", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const registry = await run(makeRegistry);
		await run(upsertPandora(registry));
		const writes: string[] = [];
		const pithos = makePithos(
			[],
			[
				{
					scope_id: "scope_greed",
					capability: "design",
					scope_kind: "worktree",
					canonical_path: "/wt",
				},
			],
		);
		await run(
			reconcileTick(await parseConfig(home)).pipe(
				Effect.provideService(Registry, registry),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(
					Ids,
					Ids.of({ nextRunId: Effect.succeed("run_greed"), nextSessionId: Effect.succeed("s") }),
				),
				Effect.provideService(
					Spawner,
					Spawner.of({
						launchAgent: (input) =>
							Effect.succeed({
								...input,
								logicalName: "pdx--greed",
								hitl: { tmuxTarget: "pdx--greed", panePid: 1 },
							}),
					}),
				),
				Effect.provideService(Tmux, alwaysLiveTmux),
				Effect.provideService(SupervisorLog, testLog),
				Effect.provideService(
					FileSystem,
					FileSystem.of({
						appendFile: () => Effect.void,
						readFile: () => Effect.succeed(""),
						mkdir: () => Effect.void,
						writeFileAtomic: (path) => Effect.sync(() => writes.push(path)),
						removeFile: () => Effect.void,
					}),
				),
			),
		);
		expect(writes).toEqual([]);
	});

	it("does not remove AFK pidfile when cleanup fails after process exit", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const registry = await run(makeRegistry);
		await run(upsertPandora(registry));
		await run(
			registry.upsert({
				runId: "run_dead",
				agent: "war",
				scopeId: "scope_repo",
				mode: "afk",
				state: "live",
				logicalName: "pdx--war",
				pid: 456,
			}),
		);
		const removes: string[] = [];
		await expect(
			run(
				reconcileTick(await parseConfig(home)).pipe(
					Effect.provideService(Registry, registry),
					Effect.provideService(
						PithosClient,
						makePithos([], [], {
							runCleanup: () =>
								Effect.fail(new PdxError({ code: "PROCESS_ERROR", message: "cleanup failed" })),
						}),
					),
					Effect.provideService(
						Ids,
						Ids.of({ nextRunId: Effect.succeed("r"), nextSessionId: Effect.succeed("s") }),
					),
					Effect.provideService(
						Spawner,
						Spawner.of({
							launchAgent: () =>
								Effect.fail(new PdxError({ code: "PROCESS_ERROR", message: "unexpected" })),
						}),
					),
					Effect.provideService(Tmux, alwaysLiveTmux),
					Effect.provideService(
						Process,
						Process.of({ ...alwaysLiveProcess, isAlive: () => Effect.succeed(false) }),
					),
					Effect.provideService(SupervisorLog, testLog),
					Effect.provideService(
						FileSystem,
						FileSystem.of({
							appendFile: () => Effect.void,
							readFile: () => Effect.succeed(""),
							mkdir: () => Effect.void,
							writeFileAtomic: () => Effect.void,
							removeFile: (path) => Effect.sync(() => removes.push(path)),
						}),
					),
				),
			),
		).rejects.toThrow("cleanup failed");
		expect(removes).toEqual([]);
	});

	it("AFK pidfile write failure rolls back launch before surfacing the error", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const registry = await run(makeRegistry);
		await run(upsertPandora(registry));
		const pithosCalls: string[] = [];
		const kills: string[] = [];
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: () => Effect.void,
			writeFileAtomic: () =>
				Effect.fail(new PdxError({ code: "FS_ERROR", message: "pidfile write failed" })),
			removeFile: () => Effect.void,
		});
		const process = Process.of({
			execFile: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
			isAlive: (pid) => Effect.succeed(!kills.includes(`${pid}:SIGTERM`)),
			kill: (pid, signal) => Effect.sync(() => kills.push(`${pid}:${signal}`)),
		});
		await expect(
			run(
				reconcileTick(await parseConfig(home)).pipe(
					Effect.provideService(Registry, registry),
					Effect.provideService(
						PithosClient,
						makePithos(pithosCalls, [
							{
								scope_id: "scope_repo",
								capability: "execute",
								scope_kind: "repo",
								canonical_path: "/repo",
							},
						]),
					),
					Effect.provideService(
						Ids,
						Ids.of({
							nextRunId: Effect.succeed("run_war"),
							nextSessionId: Effect.succeed("session_war"),
						}),
					),
					Effect.provideService(
						Spawner,
						Spawner.of({
							launchAgent: (input) =>
								Effect.succeed({
									...input,
									logicalName: "pdx--war",
									afk: { pid: 456, processStartTime: "now" },
								}),
						}),
					),
					Effect.provideService(Tmux, alwaysLiveTmux),
					Effect.provideService(Process, process),
					Effect.provideService(SupervisorLog, testLog),
					Effect.provideService(FileSystem, fs),
				),
			),
		).rejects.toThrow("pidfile write failed");
		expect(kills).toEqual(["456:SIGTERM"]);
		expect(pithosCalls).toContain("runCleanup:run_war:launch_failed");
		expect(await run(registry.list)).toEqual([expect.objectContaining({ runId: "run_pandora" })]);
	});

	it("live filesystem atomic write leaves final file and removes tmp path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const path = join(dir, "run.pid");
		await run(
			FileSystemLive.writeFileAtomic(path, "456\n").pipe(
				Effect.provideService(FileSystem, FileSystemLive),
			),
		);
		await expect(readFile(path, "utf8")).resolves.toBe("456\n");
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});

	it("starts registry empty and supports typed operations", async () => {
		const registryContext = await run(makeRegistry);
		const listEmpty = await run(
			Registry.pipe(
				Effect.flatMap((registry) => registry.list),
				Effect.provideService(Registry, registryContext),
			),
		);
		expect(listEmpty).toEqual([]);
		await run(
			Registry.pipe(
				Effect.flatMap((registry) =>
					registry.upsert({
						runId: "run_1",
						agent: "war",
						scopeId: "scope_1",
						mode: "afk",
						state: "live",
						logicalName: "pdx--war",
					}),
				),
				Effect.provideService(Registry, registryContext),
			),
		);
		const entries = await run(
			Registry.pipe(
				Effect.flatMap((registry) => registry.list),
				Effect.provideService(Registry, registryContext),
			),
		);
		expect(entries).toHaveLength(1);
	});
});
