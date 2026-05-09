import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { parsePdxConfig } from "../src/config.js";
import { parseIpcRequest } from "../src/ipc.js";
import { makeSupervisorLog } from "../src/log.js";
import {
	Clock,
	FileSystem,
	makeRegistry,
	PithosClient,
	Process,
	Registry,
	SupervisorLog,
	Tmux,
} from "../src/services.js";
import { makeTmux } from "../src/tmux.js";
import { DAEMON_TARGET, PDX_SYSTEM_RUN_ID, openPdx, runDaemon } from "../src/controller.js";

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
		const fs = FileSystem.of({ appendFile: () => Effect.void, mkdir: () => Effect.void });
		const pithos = PithosClient.of({
			run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
		});
		await expect(
			run(
				openPdx(parsePdxConfig(configInput("/tmp/pdx-home"))).pipe(
					Effect.provideService(Tmux, tmux),
					Effect.provideService(FileSystem, fs),
					Effect.provideService(PithosClient, pithos),
				),
			),
		).rejects.toThrow(`${DAEMON_TARGET} already exists`);
	});

	it("daemon startup creates runs dir and upserts pdx system run without Pandora", async () => {
		const home = await mkdtemp(join(tmpdir(), "pdx-test-"));
		const mkdirs: string[] = [];
		const pithosCalls: string[][] = [];
		const fs = FileSystem.of({
			appendFile: () => Effect.void,
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
		const handle = await run(
			runDaemon(parsePdxConfig(configInput(home))).pipe(
				Effect.provideService(FileSystem, fs),
				Effect.provideService(PithosClient, pithos),
				Effect.provideService(SupervisorLog, log),
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
		expect(pithosCalls.some((args) => args.includes("pandora"))).toBe(false);
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
