import { Deferred, Effect, Fiber, Schedule } from "effect";
import { requestIpc, listenIpc } from "./ipc-socket.js";
import type { IpcResponse } from "./ipc.js";
import { PdxError } from "./errors.js";
import type { PdxConfig } from "./config.js";
import {
	Clock,
	FileSystem,
	Ids,
	PithosClient,
	Process,
	Registry,
	Spawner,
	SupervisorLog,
	Tmux,
	type RegistryEntry,
	type TmuxService,
} from "./services.js";
import { reportLifecycle } from "./lifecycle.js";

export const DAEMON_TARGET = "pdx--daemon";
export const PANDORA_TARGET = "pdx--pandora";
export const PDX_SYSTEM_RUN_ID = "run_pdx_system";
const NO_CLAIM_TIMEOUT_MILLIS = 30_000;

const pidfilePath = (config: PdxConfig, runId: string): string => `${config.runsDir}/${runId}.pid`;
const afkStdoutPath = (config: PdxConfig, runId: string): string =>
	`${config.runsDir}/${runId}.stdout.log`;
const afkStderrPath = (config: PdxConfig, runId: string): string =>
	`${config.runsDir}/${runId}.stderr.log`;

const writeAfkPidfile = (config: PdxConfig, runId: string, pid: number) =>
	FileSystem.pipe(
		Effect.flatMap((fs) => fs.writeFileAtomic(pidfilePath(config, runId), `${pid}\n`)),
	);

const cleanupRun = (runId: string, reason: string) =>
	PithosClient.pipe(Effect.flatMap((pithos) => pithos.runCleanup({ runId, reason })));

const cleanupAfkRun = (config: PdxConfig, runId: string, reason: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		yield* cleanupRun(runId, reason);
		yield* fs.removeFile(pidfilePath(config, runId));
	});

const parsePidfile = (runId: string, raw: string): Effect.Effect<number, PdxError> => {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) {
		return Effect.fail(
			new PdxError({ code: "VALIDATION_ERROR", message: `${runId} pidfile is malformed` }),
		);
	}
	const pid = Number(trimmed);
	return pid > 0
		? Effect.succeed(pid)
		: Effect.fail(
				new PdxError({ code: "VALIDATION_ERROR", message: `${runId} pidfile is malformed` }),
			);
};

const settleHitlOrphans = () =>
	Effect.gen(function* () {
		const tmux = yield* Tmux;
		for (const session of yield* tmux.lsSessions()) {
			if (session.startsWith("pdx--") && session !== DAEMON_TARGET) {
				yield* tmux.killSession(session);
				yield* confirmTmuxGone(tmux, session);
			}
		}
	});

const settleAfkOrphan = (config: PdxConfig, filename: string) =>
	Effect.gen(function* () {
		const runId = filename.slice(0, -".pid".length);
		const fs = yield* FileSystem;
		const processService = yield* Process;
		const path = pidfilePath(config, runId);
		const pid = yield* parsePidfile(runId, yield* fs.readFile(path));
		const alive = yield* processService.isAlive(pid);
		if (alive) {
			yield* processService.kill(pid, "SIGTERM");
			const aliveAfterTerm = yield* processService.isAlive(pid);
			if (aliveAfterTerm) {
				yield* processService.kill(pid, "SIGKILL");
			}
			yield* confirmAfkGone(pid);
		}
		yield* cleanupRun(runId, "daemon_start");
		yield* fs.removeFile(path);
	});

const settleAfkOrphans = (config: PdxConfig) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const entries = yield* fs.readDirectory(config.runsDir);
		for (const entry of entries) {
			if (entry.endsWith(".pid")) {
				yield* settleAfkOrphan(config, entry);
			}
		}
	});

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

const isMissingProcessError = (error: PdxError): boolean => error.message.includes("ESRCH");

export const openPdx = (
	config: PdxConfig,
	maxAfk: number,
	intervalSeconds: number,
	input: { readonly update: boolean; readonly clean: boolean },
) =>
	Effect.gen(function* () {
		const tmux = yield* Tmux;
		const fs = yield* FileSystem;
		const pithos = yield* PithosClient;
		if (input.update && input.clean) {
			yield* Effect.fail(
				new PdxError({
					code: "VALIDATION_ERROR",
					message: "--update and --clean are mutually exclusive",
				}),
			);
		}
		const exists = yield* tmux.hasSession(DAEMON_TARGET);
		if (exists) {
			yield* Effect.fail(
				new PdxError({ code: "VALIDATION_ERROR", message: `${DAEMON_TARGET} already exists` }),
			);
		}
		if (input.clean) {
			yield* fs.removeFile(config.dataDir);
		} else if (input.update) {
			yield* fs.removeFile(`${config.dataDir}/templates`);
		}
		yield* fs.mkdir(config.dataDir);
		yield* pithos.init();
		yield* fs.mkdir(config.runsDir);
		yield* tmux.newSession({
			target: DAEMON_TARGET,
			cwd: config.dataDir,
			command: [
				config.daemonEntrypoint,
				"daemon",
				"run",
				"--data-dir",
				config.dataDir,
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

export const killPdx = (
	config: PdxConfig,
	input: {
		readonly runId: string | undefined;
		readonly taskId: string | undefined;
		readonly reason: string;
	},
) =>
	Effect.gen(function* () {
		if ((input.runId === undefined) === (input.taskId === undefined)) {
			yield* Effect.fail(
				new PdxError({
					code: "VALIDATION_ERROR",
					message: "provide exactly one of --run or --task",
				}),
			);
		}
		const response = yield* requestIpc(config.socketPath, {
			kind: "kill",
			run: input.runId,
			task: input.taskId,
			reason: input.reason,
		});
		if (!response.ok) {
			yield* Effect.fail(
				new PdxError({ code: "IPC_ERROR", message: response.error ?? "daemon kill failed" }),
			);
		}
		return response.data;
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

const queueCounts = (
	ready: readonly { readonly scope_id: string; readonly capability: string }[],
) => {
	const byScopeCapability: Record<string, Record<string, number>> = {};
	for (const { scope_id, capability } of ready) {
		byScopeCapability[scope_id] = byScopeCapability[scope_id] ?? {};
		byScopeCapability[scope_id][capability] = (byScopeCapability[scope_id][capability] ?? 0) + 1;
	}
	return { claimable: ready.length, by_scope_capability: byScopeCapability };
};

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
		yield* fs.mkdir(config.dataDir);
		yield* pithos.init();
		const ready = yield* pithos.briefing();
		const queue = queueCounts(ready);
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

const sinceCutoff = (raw: string, now: Date): Effect.Effect<number, PdxError> =>
	Effect.gen(function* () {
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
			yield* Effect.fail(
				new PdxError({ code: "VALIDATION_ERROR", message: `invalid --since value: ${raw}` }),
			);
		}
		return parsed;
	});

const logLines = (raw: string): readonly string[] =>
	raw === "" ? [] : raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");

const logTimestamp = (line: string): Effect.Effect<number, PdxError> =>
	Effect.gen(function* () {
		const parsed = yield* Effect.try({
			try: () => JSON.parse(line) as unknown,
			catch: (error) =>
				new PdxError({
					code: "VALIDATION_ERROR",
					message: `corrupt supervisor log JSONL: ${String(error)}`,
				}),
		});
		const ts =
			typeof parsed === "object" && parsed !== null
				? (parsed as { readonly ts?: unknown }).ts
				: undefined;
		const timestamp = typeof ts === "string" ? Date.parse(ts) : NaN;
		if (Number.isNaN(timestamp)) {
			yield* Effect.fail(
				new PdxError({
					code: "VALIDATION_ERROR",
					message: "corrupt supervisor log JSONL: missing valid ts",
				}),
			);
		}
		return timestamp;
	});

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
		let cutoff: number | undefined = undefined;
		if (input.since !== undefined) {
			const nowIso = yield* Clock.pipe(Effect.flatMap((clock) => clock.nowIso));
			const now = new Date(nowIso);
			if (Number.isNaN(now.getTime())) {
				yield* Effect.fail(
					new PdxError({
						code: "PROCESS_ERROR",
						message: `clock provided invalid now iso: ${nowIso}`,
					}),
				);
			}
			cutoff = yield* sinceCutoff(input.since, now);
		}
		const parsed = yield* Effect.forEach(logLines(raw), (line) =>
			logTimestamp(line).pipe(Effect.map((timestamp) => ({ line, timestamp }))),
		);
		const selected = parsed.filter(({ timestamp }) => cutoff === undefined || timestamp >= cutoff);
		const rows = selected.map((entry) => entry.line);
		const output = input.all ? rows : rows.slice(-(input.limit ?? 100));
		return output.length === 0 ? "" : `${output.join("\n")}\n`;
	});

const registryEntryForRun = (config: PdxConfig, runId: string) =>
	Effect.gen(function* () {
		const running = yield* Tmux.pipe(Effect.flatMap((tmux) => tmux.hasSession(DAEMON_TARGET)));
		const entries = (yield* readDaemonStatus(config, running, 0)).entries;
		return entries.find((entry) => entry.runId === runId) ?? null;
	});

const tmuxAttachedConfirmation = (input: {
	readonly runId: string;
	readonly target: string;
	readonly taskId?: string;
}) => ({
	ok: true as const,
	action: "tmux_attached" as const,
	target: input.target,
	run_id: input.runId,
	...(input.taskId === undefined ? {} : { task_id: input.taskId }),
});

export const runShowPdx = (config: PdxConfig, input: { readonly runId: string }) =>
	Effect.gen(function* () {
		const entry = yield* registryEntryForRun(config, input.runId);
		if (entry === null) {
			return yield* Effect.fail(
				new PdxError({
					code: "NOT_FOUND",
					message: `Run ${input.runId} is not supervised by pdx or has no live tmux session.`,
				}),
			);
		}
		const target = entry.tmuxTarget;
		if (target === undefined) {
			return yield* Effect.fail(
				new PdxError({
					code: "VALIDATION_ERROR",
					message: `Run ${input.runId} is ${entry.mode}; no tmux session to show.`,
				}),
			);
		}
		yield* Tmux.pipe(Effect.flatMap((tmux) => tmux.switchClient(target)));
		return tmuxAttachedConfirmation({ runId: input.runId, target });
	});

export const taskShowPdx = (config: PdxConfig, input: { readonly taskId: string }) =>
	Effect.gen(function* () {
		const pithos = yield* PithosClient;
		const owner = yield* pithos.activeRunForTask({ taskId: input.taskId });
		if (owner === null) {
			const task = yield* pithos.taskInspect({ taskId: input.taskId });
			return yield* Effect.fail(
				new PdxError({
					code: "VALIDATION_ERROR",
					message: `Task ${input.taskId} is ${task.task.status}; no live run to show.`,
				}),
			);
		}
		const confirmation = yield* runShowPdx(config, { runId: owner.id });
		return tmuxAttachedConfirmation({
			runId: confirmation.run_id,
			target: confirmation.target,
			taskId: input.taskId,
		});
	});

export const runTranscriptPdx = (input: {
	readonly runId: string;
	readonly limit: number | undefined;
}) =>
	Effect.gen(function* () {
		const pithos = yield* PithosClient;
		const spawner = yield* Spawner;
		const run = yield* pithos.runInspect({ runId: input.runId });
		if (run.harness_kind === "system") {
			return yield* Effect.fail(
				new PdxError({
					code: "VALIDATION_ERROR",
					message: `Run ${run.id} is a system run; use 'pdx daemon logs' for supervisor logs.`,
				}),
			);
		}
		return yield* spawner.renderSessionTranscript({
			harnessKind: run.harness_kind,
			sessionLogPath: run.session_log_path,
			limit: input.limit,
		});
	});

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

const confirmAfkGone = (pid: number) =>
	isAfkAlive(pid).pipe(
		Effect.flatMap((alive) =>
			alive
				? Effect.fail(
						new PdxError({
							code: "PROCESS_ERROR",
							message: `${pid} still alive after kill`,
						}),
					)
				: Effect.void,
		),
	);

export const isAfkAlive = (pid: number) =>
	Process.pipe(Effect.flatMap((processService) => processService.isAlive(pid)));

const killEntryResource = (entry: RegistryEntry, signal: "SIGTERM" | "SIGKILL") =>
	Effect.gen(function* () {
		if (entry.mode === "hitl") {
			const target = entry.tmuxTarget;
			if (target === undefined) {
				return yield* Effect.fail(
					new PdxError({ code: "VALIDATION_ERROR", message: `${entry.runId} missing tmux target` }),
				);
			}
			const tmux = yield* Tmux;
			yield* tmux.killSession(target);
			return;
		}
		const pid = entry.pid;
		if (pid === undefined) {
			return yield* Effect.fail(
				new PdxError({ code: "VALIDATION_ERROR", message: `${entry.runId} missing pid` }),
			);
		}
		const processService = yield* Process;
		yield* processService.kill(pid, signal);
	});

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

const noClaimTimedOut = (entry: RegistryEntry, nowIso: string): Effect.Effect<boolean, PdxError> =>
	Effect.gen(function* () {
		if (entry.agent === "pandora" || entry.everClaimed === true) return false;
		const launchedAtIso = entry.launchedAt;
		if (launchedAtIso === undefined) {
			return yield* Effect.fail(
				new PdxError({ code: "VALIDATION_ERROR", message: `${entry.runId} missing launchedAt` }),
			);
		}
		const launchedAt = Date.parse(launchedAtIso);
		const now = Date.parse(nowIso);
		if (Number.isNaN(launchedAt) || Number.isNaN(now)) {
			yield* Effect.fail(
				new PdxError({
					code: "VALIDATION_ERROR",
					message: `${entry.runId} has invalid no-claim timeout timestamp`,
				}),
			);
		}
		return now - launchedAt >= NO_CLAIM_TIMEOUT_MILLIS;
	});

const confirmEntryGone = (entry: RegistryEntry) =>
	entry.mode === "hitl"
		? Tmux.pipe(
				Effect.flatMap((tmux) => {
					if (entry.tmuxTarget === undefined) {
						return Effect.fail(
							new PdxError({
								code: "VALIDATION_ERROR",
								message: `${entry.runId} missing tmux target`,
							}),
						);
					}
					return confirmTmuxGone(tmux, entry.tmuxTarget);
				}),
			)
		: entry.pid === undefined
			? Effect.fail(
					new PdxError({ code: "VALIDATION_ERROR", message: `${entry.runId} missing pid` }),
				)
			: confirmAfkGone(entry.pid);

const removeSettledEntry = (
	config: PdxConfig,
	entry: RegistryEntry,
	input: {
		readonly span: "pdx.reconcile" | "pdx.kill";
		readonly message: string;
		readonly reason: "terminated" | "natural_death" | "no_claim_timeout";
	},
) =>
	Effect.gen(function* () {
		const registry = yield* Registry;
		const log = yield* SupervisorLog;
		if (entry.mode === "afk") {
			const fs = yield* FileSystem;
			yield* fs.removeFile(pidfilePath(config, entry.runId));
		}
		yield* registry.remove(entry.runId);
		yield* log.write({
			level: "info",
			span: input.span,
			msg: input.message,
			data: { run_id: entry.runId },
		});
		yield* reportLifecycle({
			kind: "removed",
			agent: entry.agent,
			runId: entry.runId,
			scopeId: entry.scopeId,
			reason: input.reason,
			tmuxTarget: entry.tmuxTarget,
			pid: entry.pid,
		});
	});

const settleNoClaimTimeout = (config: PdxConfig, entry: RegistryEntry) =>
	Effect.gen(function* () {
		const pithos = yield* PithosClient;
		yield* killEntryResource(entry, "SIGTERM");
		yield* confirmEntryGone(entry);
		yield* pithos.runTimeout({ runId: entry.runId, reason: "no_claim_timeout" });
		yield* removeSettledEntry(config, entry, {
			span: "pdx.reconcile",
			message: "removed no-claim timed out entry",
			reason: "no_claim_timeout",
		});
	});

const agentPolicy = {
	toil: { capability: "triage", mode: "afk" },
	greed: { capability: "design", mode: "hitl" },
	war: { capability: "execute", mode: "afk" },
} as const;

const hasAgentScopeCap = (
	entries: readonly RegistryEntry[],
	agent: "toil" | "greed" | "war",
	scopeId: string,
): boolean => entries.some((entry) => entry.agent === agent && entry.scopeId === scopeId);

const hasAfkCapacity = (entries: readonly RegistryEntry[], maxAfk: number): boolean =>
	entries.filter((entry) => entry.agent !== "pandora" && entry.mode === "afk").length < maxAfk;

const WAKEUP_MARKER = "# wakeup: claimable escalate";

const sendEscalateWakeupIfNeeded = () =>
	Effect.gen(function* () {
		const registry = yield* Registry;
		const pithos = yield* PithosClient;
		const tmux = yield* Tmux;
		const log = yield* SupervisorLog;
		const ready = yield* pithos.briefing();
		const claimableEscalateCount = ready.filter(
			(task) => task.scope_id === "global" && task.capability === "escalate",
		).length;
		const previousCount = yield* registry.lastEscalateClaimableCount;
		if (previousCount === 0 && claimableEscalateCount > 0) {
			yield* tmux.sendLiteralLine(PANDORA_TARGET, WAKEUP_MARKER);
			yield* log.write({
				level: "info",
				span: "pdx.wakeup",
				msg: "sent Pandora wakeup",
				data: { target: PANDORA_TARGET, claimable_escalate_count: claimableEscalateCount },
			});
			yield* reportLifecycle({
				kind: "wakeup",
				reason: "claimable_escalate",
				target: PANDORA_TARGET,
				claimableEscalateCount,
			});
		}
		yield* registry.setLastEscalateClaimableCount(claimableEscalateCount);
	});

const spawnReadyAgent = (config: PdxConfig, maxAfk: number) =>
	Effect.gen(function* () {
		const registry = yield* Registry;
		const pithos = yield* PithosClient;
		const ids = yield* Ids;
		const spawner = yield* Spawner;
		const log = yield* SupervisorLog;
		const entries = yield* registry.list;
		const ready = yield* pithos.briefing();
		for (const agent of ["toil", "greed", "war"] as const) {
			const policy = agentPolicy[agent];
			const task = ready.find(
				(candidate) =>
					candidate.capability === policy.capability &&
					!hasAgentScopeCap(entries, agent, candidate.scope_id) &&
					(policy.mode !== "afk" || hasAfkCapacity(entries, maxAfk)),
			);
			if (task === undefined) continue;
			const cwd = task.scope_kind === "global" ? config.dataDir : task.canonical_path;
			if (cwd === null) {
				return yield* Effect.fail(
					new PdxError({
						code: "VALIDATION_ERROR",
						message: `${task.scope_id} missing canonical_path for ${task.scope_kind} scope`,
					}),
				);
			}
			const runId = yield* ids.nextRunId;
			const sessionId = yield* ids.nextSessionId;
			const launchedAt = yield* Clock.pipe(Effect.flatMap((clock) => clock.nowIso));
			const rendered = yield* spawner.renderAgent({
				agent,
				mode: policy.mode,
				runId,
				sessionId,
				scopeId: task.scope_id,
				cwd,
			});
			yield* pithos.runUpsert({
				agent,
				mode: policy.mode,
				scope: task.scope_id,
				cwd,
				sessionId,
				harnessKind: rendered.harness.kind,
				sessionLogPath: rendered.sessionLogPath,
				runId,
			});
			yield* registry.upsert({
				runId,
				agent,
				mode: policy.mode,
				scopeId: task.scope_id,
				state: "launching",
				logicalName: rendered.logicalName,
				launchedAt,
				everClaimed: false,
			});
			yield* log.write({
				level: "info",
				span: "pdx.launch",
				msg: "launching agent",
				data: {
					agent,
					mode: policy.mode,
					run_id: runId,
					session_id: sessionId,
					scope_id: task.scope_id,
					cwd,
					pithos_db: config.pithosDbPath,
				},
			});
			const launched = yield* spawner
				.launchRenderedAgent(rendered)
				.pipe(
					Effect.catchAll((error) =>
						cleanupRun(runId, "launch_failed").pipe(
							Effect.zipRight(registry.remove(runId)),
							Effect.zipRight(Effect.fail(error)),
						),
					),
				);
			const liveEntry =
				policy.mode === "hitl"
					? launched.hitl === undefined
						? undefined
						: { tmuxTarget: launched.hitl.tmuxTarget }
					: launched.afk === undefined
						? undefined
						: { pid: launched.afk.pid };
			const afk = launched.afk;
			if (afk !== undefined) {
				yield* writeAfkPidfile(config, runId, afk.pid).pipe(
					Effect.catchAll((error) =>
						killEntryResource(
							{
								runId,
								agent,
								mode: "afk",
								scopeId: task.scope_id,
								state: "launching",
								logicalName: launched.logicalName,
								launchedAt,
								everClaimed: false,
								pid: afk.pid,
							},
							"SIGTERM",
						).pipe(
							Effect.zipRight(confirmAfkGone(afk.pid)),
							Effect.zipRight(cleanupAfkRun(config, runId, "launch_failed")),
							Effect.zipRight(registry.remove(runId)),
							Effect.zipRight(Effect.fail(error)),
						),
					),
				);
			}
			if (liveEntry === undefined) {
				yield* cleanupRun(runId, "launch_failed");
				yield* registry.remove(runId);
				yield* Effect.fail(
					new PdxError({
						code: "PROCESS_ERROR",
						message: `${agent} launch missing ${policy.mode} metadata`,
					}),
				);
			}
			yield* registry.upsert({
				runId,
				agent,
				mode: policy.mode,
				scopeId: task.scope_id,
				state: "live",
				logicalName: launched.logicalName,
				launchedAt,
				everClaimed: false,
				...liveEntry,
			});
			yield* log.write({
				level: "info",
				span: "pdx.reconcile",
				msg: `spawned ${agent}`,
				data: {
					run_id: runId,
					scope_id: task.scope_id,
					logical_name: launched.logicalName,
					harness_kind: launched.harnessKind,
					harness_argv: rendered.harness.argv,
					harness_env_keys: Object.keys(rendered.harness.env),
					session_log_path: launched.sessionLogPath,
					pid: afk?.pid ?? null,
					stdout_path: policy.mode === "afk" ? afkStdoutPath(config, runId) : null,
					stderr_path: policy.mode === "afk" ? afkStderrPath(config, runId) : null,
				},
			});
			yield* reportLifecycle({
				kind: "spawned",
				agent,
				mode: policy.mode,
				runId,
				scopeId: task.scope_id,
				sessionId,
				tmuxTarget: launched.hitl?.tmuxTarget,
				pid: launched.afk?.pid,
			});
			return;
		}
	});

export const reconcileTick = (config: PdxConfig, maxAfk = 4) =>
	Effect.gen(function* () {
		const registry = yield* Registry;
		const pithos = yield* PithosClient;
		const ids = yield* Ids;
		const spawner = yield* Spawner;
		const log = yield* SupervisorLog;
		const nowIso = yield* Clock.pipe(Effect.flatMap((clock) => clock.nowIso));
		for (const entry of yield* registry.list) {
			const alive = yield* entryAlive(entry);
			if (entry.state === "terminating") {
				if (!alive) {
					yield* registry.remove(entry.runId);
					yield* log.write({
						level: "info",
						span: "pdx.kill",
						msg: "removed terminated entry",
						data: { run_id: entry.runId },
					});
					yield* reportLifecycle({
						kind: "removed",
						agent: entry.agent,
						runId: entry.runId,
						scopeId: entry.scopeId,
						reason: "terminated",
						tmuxTarget: entry.tmuxTarget,
						pid: entry.pid,
					});
				} else {
					const attempts = (entry.killAttempts ?? 0) + 1;
					const signal = attempts === 1 ? "SIGTERM" : "SIGKILL";
					yield* killEntryResource(entry, signal).pipe(
						Effect.catchAll((error) =>
							log.write({
								level: "warn",
								span: "pdx.kill.retry",
								msg: "kill attempt failed",
								data: { run_id: entry.runId, signal, error: error.message },
							}),
						),
					);
					yield* registry.upsert({ ...entry, killAttempts: attempts });
				}
			} else if (!alive) {
				let stdout: string | null = null;
				let stderr: string | null = null;
				if (entry.mode === "afk") {
					const fs = yield* FileSystem;
					stdout = yield* fs.readFile(afkStdoutPath(config, entry.runId));
					stderr = yield* fs.readFile(afkStderrPath(config, entry.runId));
					yield* cleanupAfkRun(config, entry.runId, "natural_death");
				} else {
					yield* cleanupRun(entry.runId, "natural_death");
				}
				yield* registry.remove(entry.runId);
				yield* log.write({
					level: "info",
					span: "pdx.reconcile",
					msg: "removed dead entry",
					data: {
						run_id: entry.runId,
						agent: entry.agent,
						mode: entry.mode,
						pid: entry.pid ?? null,
						stdout_path: entry.mode === "afk" ? afkStdoutPath(config, entry.runId) : null,
						stderr_path: entry.mode === "afk" ? afkStderrPath(config, entry.runId) : null,
						stdout_tail: stdout === null ? null : stdout.slice(-4000),
						stderr_tail: stderr === null ? null : stderr.slice(-4000),
					},
				});
				yield* reportLifecycle({
					kind: "removed",
					agent: entry.agent,
					runId: entry.runId,
					scopeId: entry.scopeId,
					reason: "natural_death",
					tmuxTarget: entry.tmuxTarget,
					pid: entry.pid,
				});
			} else if (entry.state === "live") {
				const run = yield* pithos.runInspect({ runId: entry.runId });
				const observedEntry = run.task_id === null ? entry : { ...entry, everClaimed: true };
				if (observedEntry !== entry) {
					yield* registry.upsert(observedEntry);
				}
				if (
					entry.agent !== "pandora" &&
					entry.mode === "hitl" &&
					observedEntry.everClaimed === true &&
					run.task_id === null
				) {
					yield* killEntryResource(observedEntry, "SIGTERM");
					yield* confirmEntryGone(observedEntry);
					yield* cleanupRun(observedEntry.runId, "task_cleared");
					yield* removeSettledEntry(config, observedEntry, {
						span: "pdx.reconcile",
						message: "removed completed HITL entry",
						reason: "terminated",
					});
				} else if (run.task_id === null && (yield* noClaimTimedOut(observedEntry, nowIso))) {
					yield* settleNoClaimTimeout(config, observedEntry);
				} else if (entry.mode === "hitl") {
					yield* pithos.taskHeartbeat({ runId: entry.runId });
				}
			}
		}
		const entries = yield* registry.list;
		if (!entries.some((entry) => entry.agent === "pandora")) {
			const runId = yield* ids.nextRunId;
			const sessionId = yield* ids.nextSessionId;
			const launchedAt = yield* Clock.pipe(Effect.flatMap((clock) => clock.nowIso));
			const rendered = yield* spawner.renderAgent({
				agent: "pandora",
				mode: "hitl",
				runId,
				sessionId,
				scopeId: "global",
				cwd: config.dataDir,
			});
			yield* pithos.runUpsert({
				agent: "pandora",
				mode: "hitl",
				scope: "global",
				cwd: config.dataDir,
				sessionId,
				harnessKind: rendered.harness.kind,
				sessionLogPath: rendered.sessionLogPath,
				runId,
			});
			yield* log.write({
				level: "info",
				span: "pdx.launch",
				msg: "launching agent",
				data: {
					agent: "pandora",
					mode: "hitl",
					run_id: runId,
					session_id: sessionId,
					scope_id: "global",
					cwd: config.dataDir,
					pithos_db: config.pithosDbPath,
				},
			});
			const launched = yield* spawner
				.launchRenderedAgent(rendered)
				.pipe(
					Effect.catchAll((error) =>
						cleanupRun(runId, "launch_failed").pipe(Effect.zipRight(Effect.fail(error))),
					),
				);
			const tmuxTarget = launched.hitl?.tmuxTarget;
			if (tmuxTarget === undefined) {
				yield* cleanupRun(runId, "launch_failed");
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
					launchedAt,
					everClaimed: false,
					tmuxTarget,
				});
			}
			yield* log.write({
				level: "info",
				span: "pdx.reconcile",
				msg: "spawned pandora",
				data: {
					run_id: runId,
					logical_name: launched.logicalName,
					harness_kind: launched.harnessKind,
					harness_argv: rendered.harness.argv,
					harness_env_keys: Object.keys(rendered.harness.env),
					session_log_path: launched.sessionLogPath,
					tmux_target: tmuxTarget ?? null,
				},
			});
			yield* reportLifecycle({
				kind: "spawned",
				agent: "pandora",
				mode: "hitl",
				runId,
				scopeId: "global",
				sessionId,
				tmuxTarget,
			});
		}
		yield* sendEscalateWakeupIfNeeded();
		yield* spawnReadyAgent(config, maxAfk);
	});

const escalationBody = (input: {
	readonly runId: string;
	readonly taskId: string;
	readonly scopeId: string;
	readonly reason: string;
}) =>
	`pdx kill interrupted a live run.\n\nRun: ${input.runId}\nTask: ${input.taskId}\nScope: ${input.scopeId}\nReason: ${input.reason}\n\nSuggested next steps: inspect the failed task and artifacts, decide whether to supersede, cancel, or replan the broken chain, then enqueue follow-up work if needed.`;

export const handleKillRequest = (input: {
	readonly run: string | undefined;
	readonly task: string | undefined;
	readonly reason: string;
}) =>
	Effect.gen(function* () {
		if ((input.run === undefined) === (input.task === undefined)) {
			yield* Effect.fail(
				new PdxError({ code: "VALIDATION_ERROR", message: "provide exactly one of run or task" }),
			);
		}

		const pithos = yield* PithosClient;
		const registry = yield* Registry;
		const entries = yield* registry.list;

		const interruptResult = yield* Effect.gen(function* () {
			if (input.run !== undefined) {
				const run = yield* pithos.runInspect({ runId: input.run });
				if (["ended", "failed", "cancelled", "timed_out"].includes(run.status)) {
					yield* Effect.fail(
						new PdxError({
							code: "VALIDATION_ERROR",
							message: `Run ${run.id} is terminal (${run.status}); no live run can be killed.`,
						}),
					);
				}
				if (!entries.some((entry) => entry.runId === run.id)) {
					yield* Effect.fail(
						new PdxError({
							code: "VALIDATION_ERROR",
							message: `Run ${run.id} is not supervised by pdx; no live resource can be killed.`,
						}),
					);
				}
				return yield* pithos.runInterrupt({ runId: run.id, reason: input.reason });
			}

			if (input.task === undefined) {
				return yield* Effect.fail(
					new PdxError({ code: "VALIDATION_ERROR", message: "kill requires --task" }),
				);
			}
			const owner = yield* pithos.activeRunForTask({ taskId: input.task });
			if (owner === null) {
				return yield* Effect.fail(
					new PdxError({
						code: "VALIDATION_ERROR",
						message: `Task ${input.task} is not held by any active run; use 'pithos task cancel' for non-held abandonment.`,
					}),
				);
			}
			if (!entries.some((entry) => entry.runId === owner.id)) {
				return yield* Effect.fail(
					new PdxError({
						code: "VALIDATION_ERROR",
						message: `Run ${owner.id} is not supervised by pdx; no live resource can be killed.`,
					}),
				);
			}
			return yield* pithos.runInterrupt({
				taskId: input.task,
				reason: input.reason,
				expectedRunId: owner.id,
			});
		});

		const runId = interruptResult.run.id;
		const entry = (yield* registry.list).find((candidate) => candidate.runId === runId);
		if (entry === undefined) {
			return yield* Effect.fail(
				new PdxError({
					code: "VALIDATION_ERROR",
					message: `Run ${runId} is not supervised by pdx; no live resource can be killed.`,
				}),
			);
		}
		if (interruptResult.interruptedTask !== null) {
			yield* pithos.taskEnqueue({
				scope: "global",
				capability: "escalate",
				title: `Investigate interrupted task ${interruptResult.interruptedTask.id}`,
				body: escalationBody({
					runId,
					taskId: interruptResult.interruptedTask.id,
					scopeId: interruptResult.interruptedTask.scope_id,
					reason: input.reason,
				}),
				runId: PDX_SYSTEM_RUN_ID,
			});
		}
		yield* registry.upsert({ ...entry, state: "terminating", killAttempts: 1 });
		yield* killEntryResource(entry, "SIGTERM");
		return {
			ok: true,
			data: { run_id: runId, task_id: interruptResult.interruptedTask?.id ?? null },
		} as const;
	});

export const runDaemon = (config: PdxConfig, maxAfk: number, intervalSeconds: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const pithos = yield* PithosClient;
		const log = yield* SupervisorLog;
		yield* fs.mkdir(config.runsDir);
		yield* log.write({ level: "info", span: "pdx.daemon", msg: "daemon starting" });
		yield* settleHitlOrphans();
		yield* settleAfkOrphans(config);
		yield* pithos.scopeUpsert({ kind: "global" });
		yield* pithos.runUpsert({
			agent: "pdx",
			mode: "afk",
			scope: "global",
			cwd: config.dataDir,
			sessionId: DAEMON_TARGET,
			harnessKind: "system",
			sessionLogPath: config.logPath,
			runId: PDX_SYSTEM_RUN_ID,
		});
		const registry = yield* Registry;
		const tmux = yield* Tmux;
		const processService = yield* Process;
		yield* reconcileTick(config, maxAfk);
		const loop = yield* reconcileTick(config, maxAfk).pipe(
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
				} else if (entry.pid !== undefined) {
					yield* processService
						.kill(entry.pid, "SIGTERM")
						.pipe(
							Effect.catchAll((error) =>
								isMissingProcessError(error) ? Effect.void : Effect.fail(error),
							),
						);
					const alive = yield* processService.isAlive(entry.pid);
					if (alive) {
						yield* Effect.fail(
							new PdxError({
								code: "PROCESS_ERROR",
								message: `${entry.pid} still alive after kill`,
							}),
						);
					}
				}
				yield* pithos.runCleanup({ runId: entry.runId, reason: "pdx_close" });
				if (entry.mode === "afk") {
					yield* fs.removeFile(pidfilePath(config, entry.runId));
				}
				yield* registry.remove(entry.runId);
			}
			yield* pithos.runCleanup({ runId: PDX_SYSTEM_RUN_ID, reason: "pdx_close" });
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
			if (request.kind === "kill") {
				return handleKillRequest({
					run: request.run,
					task: request.task,
					reason: request.reason,
				}).pipe(
					Effect.provideService(PithosClient, pithos),
					Effect.provideService(Registry, registry),
					Effect.provideService(Tmux, tmux),
					Effect.provideService(Process, processService),
				);
			}
			return stop;
		});
		yield* log.write({ level: "info", span: "pdx.daemon", msg: "daemon ready" });
		return { ...handle, shutdown: Deferred.await(shutdown) };
	});
