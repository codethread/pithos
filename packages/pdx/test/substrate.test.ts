import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { parsePdxConfig } from "../src/config.js";
import { PdxError } from "../src/errors.js";
import { parseIpcRequest } from "../src/ipc.js";
import { requestIpc } from "../src/ipc-socket.js";
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
} from "../src/services.js";
import { makeTmux } from "../src/tmux.js";
import {
	DAEMON_TARGET,
	PANDORA_TARGET,
	logsShowPdx,
	openPdx,
	PDX_SYSTEM_RUN_ID,
	isAfkAlive,
	reconcileTick,
	runDaemon,
	statusPdx,
} from "../src/controller.js";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.runPromise(effect as Effect.Effect<A, E, never>);

const configInput = (home: string) => ({
	home,
	envHome: "/tmp/user-home",
	daemonEntrypoint: "/tmp/pdx-dev",
});

describe("pdx substrate", () => {
	it("derives config paths from home", () => {
		const config = parsePdxConfig(configInput("/tmp/pdx-home"));
		expect(config).toMatchObject({
			home: "/tmp/pdx-home",
			socketPath: "/tmp/pdx-home/pdx.sock",
			logPath: "/tmp/pdx-home/pdx.jsonl",
			runsDir: "/tmp/pdx-home/runs",
		});
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

	it("rejects malformed and unknown IPC requests loudly", () => {
		expect(() => parseIpcRequest("{")).toThrow(/Malformed IPC request JSON/);
		expect(() => parseIpcRequest(JSON.stringify({ kind: "kill" }))).toThrow(/Invalid IPC request/);
		expect(parseIpcRequest(JSON.stringify({ kind: "ping" }))).toEqual({ kind: "ping" });
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
		});
		const pithos = PithosClient.of({
			run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
		});
		await expect(
			run(
				openPdx(parsePdxConfig(configInput("/tmp/pdx-home")), 4, 5).pipe(
					Effect.provideService(Tmux, tmux),
					Effect.provideService(FileSystem, fs),
					Effect.provideService(PithosClient, pithos),
				),
			),
		).rejects.toThrow(`${DAEMON_TARGET} already exists`);
	});

	it("daemon startup creates runs dir, system run, and Pandora singleton", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const mkdirs: string[] = [];
		const pithosCalls: string[][] = [];
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: (path) => Effect.sync(() => mkdirs.push(path)),
		});
		const pithos = PithosClient.of({
			run: (args) =>
				Effect.sync(() => {
					pithosCalls.push([...args]);
					return { exitCode: 0, stdout: "{}", stderr: "" };
				}),
		});
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
		const tmux = Tmux.of({
			hasSession: () => Effect.succeed(true),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: () => Effect.void,
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		const handle = await run(
			runDaemon(parsePdxConfig(configInput(home)), 4, 5).pipe(
				Effect.provideService(FileSystem, fs),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(SupervisorLog, log),
				Effect.provideService(Registry, registry),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
			),
		);
		await run(handle.close);
		expect(mkdirs).toEqual([`${home}/runs`]);
		expect(pithosCalls).toContainEqual(["scope", "upsert", "--kind", "global"]);
		expect(pithosCalls).toContainEqual([
			"run",
			"upsert",
			"--agent",
			"pdx",
			"--mode",
			"afk",
			"--scope",
			"global",
			"--cwd",
			home,
			"--session-id",
			DAEMON_TARGET,
			"--run",
			PDX_SYSTEM_RUN_ID,
		]);
		expect(pithosCalls).toContainEqual([
			"run",
			"upsert",
			"--agent",
			"pandora",
			"--mode",
			"hitl",
			"--scope",
			"global",
			"--cwd",
			home,
			"--session-id",
			"session_pandora_1",
			"--run",
			"run_pandora_1",
		]);
	});

	it("daemon stop replies after cleanup and closes the IPC socket explicitly", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const pithosCalls: string[][] = [];
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: () => Effect.void,
		});
		const pithos = PithosClient.of({
			run: (args) =>
				Effect.sync(() => {
					pithosCalls.push([...args]);
					return { exitCode: 0, stdout: "{}", stderr: "" };
				}),
		});
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
		const tmux = Tmux.of({
			hasSession: (target) => Effect.succeed(!killed.includes(target)),
			lsSessions: () => Effect.succeed([]),
			newSession: () => Effect.void,
			killSession: (target) => Effect.sync(() => killed.push(target)),
			sendLiteralLine: () => Effect.void,
			pasteBuffer: () => Effect.void,
		});
		const config = parsePdxConfig(configInput(home));
		const handle = await run(
			runDaemon(config, 4, 5).pipe(
				Effect.provideService(FileSystem, fs),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(SupervisorLog, log),
				Effect.provideService(Registry, registry),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
			),
		);
		const response = await run(requestIpc(config.socketPath, { kind: "stop" }));
		await run(handle.shutdown);
		await run(handle.close);
		expect(response).toEqual({ ok: true, data: { stopped: true } });
		expect(pithosCalls.at(-1)).toEqual([
			"run",
			"cleanup",
			"--run",
			PDX_SYSTEM_RUN_ID,
			"--reason",
			"pdx_close",
		]);
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
		const pithosCalls: string[][] = [];
		const pithos = PithosClient.of({
			run: (args) =>
				Effect.sync(() => {
					pithosCalls.push([...args]);
					return args[0] === "init"
						? { exitCode: 0, stdout: "{}", stderr: "" }
						: {
								exitCode: 0,
								stdout: JSON.stringify({
									ok: true,
									ready: [{ id: "task_1", scope_id: "global", capability: "escalate" }],
									blocked: [],
								}),
								stderr: "",
							};
				}),
		});
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: () => Effect.void,
		});
		const status = await run(
			statusPdx(parsePdxConfig(configInput("/tmp/pdx-home")), 7).pipe(
				Effect.provideService(Tmux, tmux),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(FileSystem, fs),
			),
		);
		expect(pithosCalls).toEqual([["init"], ["briefing"]]);
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
		const pithos = PithosClient.of({
			run: () => Effect.succeed({ exitCode: 0, stdout: "{}", stderr: "" }),
		});
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed(""),
			mkdir: () => Effect.void,
		});
		await expect(
			run(
				statusPdx(parsePdxConfig(configInput("/tmp/pdx-home")), 4).pipe(
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
		});
		const config = parsePdxConfig(configInput("/tmp/pdx-home"));
		const defaultOutput = await run(
			logsShowPdx(config, { limit: undefined, all: false, since: undefined }).pipe(
				Effect.provideService(FileSystem, fs),
			),
		);
		expect(defaultOutput).toBe(`${lines.slice(1).join("\n")}\n`);
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
			}).pipe(Effect.provideService(FileSystem, fs)),
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
		});
		const config = parsePdxConfig(configInput("/tmp/pdx-home"));
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
					),
				),
			).resolves.toEqual(expect.any(String));
		}
		await expect(
			run(
				logsShowPdx(config, { limit: undefined, all: true, since: "soon" }).pipe(
					Effect.provideService(FileSystem, fs),
				),
			),
		).rejects.toThrow("invalid --since value");
		const corruptFs = FileSystem.of({
			appendFile: () => Effect.void,
			readFile: () => Effect.succeed("{\n"),
			mkdir: () => Effect.void,
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
		});
		const deadProcess = Process.of({
			execFile: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
			isAlive: () => Effect.succeed(false),
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
		const pithosCalls: string[][] = [];
		const pithos = PithosClient.of({
			run: (args) =>
				Effect.sync(() => {
					pithosCalls.push([...args]);
					return { exitCode: 0, stdout: "{}", stderr: "" };
				}),
		});
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
			reconcileTick(parsePdxConfig(configInput(home))).pipe(
				Effect.provideService(Registry, registry),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(Ids, ids),
				Effect.provideService(Spawner, spawner),
				Effect.provideService(Tmux, tmux),
				Effect.provideService(SupervisorLog, log),
			),
		);
		const entries = await run(registry.list);
		expect(entries.map((entry) => entry.runId)).toEqual(["run_new"]);
		expect(pithosCalls).toContainEqual([
			"run",
			"cleanup",
			"--run",
			"run_old",
			"--reason",
			"natural_death",
		]);
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
