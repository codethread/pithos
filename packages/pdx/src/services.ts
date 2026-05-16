import { Context, Effect, SynchronizedRef } from "effect";
import type { RepairAlertKind, RunOutput as PithosRunOutput } from "@pdx/pithos";
import type { HooksConfig } from "@pdx/spawner";
import type { PdxError } from "./errors.js";

export interface ProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ProcessService {
	readonly execFile: (
		file: string,
		args: readonly string[],
		options?: { readonly cwd?: string; readonly env?: Record<string, string> },
	) => Effect.Effect<ProcessResult, PdxError>;
	readonly isAlive: (pid: number) => Effect.Effect<boolean, PdxError>;
	readonly kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void, PdxError>;
}
export class Process extends Context.Tag("pdx/Process")<Process, ProcessService>() {}

export interface FileSystemService {
	readonly appendFile: (path: string, content: string) => Effect.Effect<void, PdxError>;
	readonly readFile: (path: string) => Effect.Effect<string, PdxError>;
	readonly readDirectory: (path: string) => Effect.Effect<readonly string[], PdxError>;
	readonly existsDirectory: (path: string) => Effect.Effect<boolean, PdxError>;
	readonly mkdir: (path: string) => Effect.Effect<void, PdxError>;
	readonly writeFileAtomic: (path: string, content: string) => Effect.Effect<void, PdxError>;
	readonly removeFile: (path: string) => Effect.Effect<void, PdxError>;
}
export class FileSystem extends Context.Tag("pdx/FileSystem")<FileSystem, FileSystemService>() {}

export interface ClockService {
	readonly nowIso: Effect.Effect<string>;
}
export class Clock extends Context.Tag("pdx/Clock")<Clock, ClockService>() {}

export interface IdsService {
	readonly nextRunId: Effect.Effect<string, PdxError>;
	readonly nextSessionId: Effect.Effect<string, PdxError>;
}
export class Ids extends Context.Tag("pdx/Ids")<Ids, IdsService>() {}

export interface TmuxPresence {
	readonly attached: number;
	readonly lastActivityUnix: number | null;
}

export interface TmuxService {
	readonly hasSession: (target: string) => Effect.Effect<boolean, PdxError>;
	readonly lsSessions: () => Effect.Effect<readonly string[], PdxError>;
	readonly newSession: (input: {
		readonly target: string;
		readonly command: readonly string[];
		readonly cwd: string;
	}) => Effect.Effect<void, PdxError>;
	readonly killSession: (target: string) => Effect.Effect<void, PdxError>;
	readonly switchClient: (target: string) => Effect.Effect<void, PdxError>;
	readonly sendLiteralLine: (target: string, text: string) => Effect.Effect<void, PdxError>;
	readonly pasteBuffer: (target: string, content: string) => Effect.Effect<void, PdxError>;
	readonly presence: (target: string) => Effect.Effect<TmuxPresence, PdxError>;
}
export class Tmux extends Context.Tag("pdx/Tmux")<Tmux, TmuxService>() {}

export type PdxRunOutput = PithosRunOutput;

export interface PithosInterruptResult {
	readonly run: PdxRunOutput;
	readonly interruptedTask: { readonly id: string; readonly scope_id: string } | null;
}

export interface PithosReadyTask {
	readonly id: string;
	readonly scope_id: string;
	readonly scope_kind: "global" | "repo" | "worktree";
	readonly canonical_path: string | null;
	readonly capability: "triage" | "design" | "execute" | "escalate" | "intake";
}

export interface PithosClientService {
	readonly init: () => Effect.Effect<void, PdxError>;
	readonly scopeUpsert: (input: {
		readonly kind: "global" | "repo" | "worktree";
		readonly path?: string;
	}) => Effect.Effect<void, PdxError>;
	readonly runUpsert: (input: {
		readonly agent: string;
		readonly mode: "afk" | "hitl";
		readonly scope: string;
		readonly cwd: string;
		readonly sessionId: string;
		readonly harnessKind: "claude" | "pi" | "system";
		readonly sessionLogPath: string;
		readonly runId?: string;
	}) => Effect.Effect<void, PdxError>;
	readonly runCleanup: (input: {
		readonly runId: string;
		readonly reason: string;
	}) => Effect.Effect<void, PdxError>;
	readonly runInterrupt: (input: {
		readonly runId?: string;
		readonly taskId?: string;
		readonly reason: string;
		readonly expectedRunId?: string;
	}) => Effect.Effect<PithosInterruptResult, PdxError>;
	readonly runTimeout: (input: {
		readonly runId: string;
		readonly reason: string;
	}) => Effect.Effect<void, PdxError>;
	readonly runLaunchAbort: (input: {
		readonly runId: string;
		readonly reason: string;
	}) => Effect.Effect<void, PdxError>;
	readonly runInspect: (input: { readonly runId: string }) => Effect.Effect<PdxRunOutput, PdxError>;
	readonly activeRunForTask: (input: {
		readonly taskId: string;
	}) => Effect.Effect<PdxRunOutput | null, PdxError>;
	readonly taskInspect: (input: { readonly taskId: string }) => Effect.Effect<
		{
			readonly task: {
				readonly id: string;
				readonly status: string;
				readonly scope_id: string;
				readonly capability: "triage" | "design" | "execute" | "escalate" | "intake";
				readonly canonical_path: string | null;
			};
		},
		PdxError
	>;
	readonly taskHeartbeat: (input: { readonly runId: string }) => Effect.Effect<void, PdxError>;
	readonly taskEnqueue: (input: {
		readonly scope: string;
		readonly capability: "triage" | "design" | "execute" | "escalate" | "intake";
		readonly title: string;
		readonly body: string;
		readonly runId?: string;
		readonly dependsOn?: readonly string[];
	}) => Effect.Effect<void, PdxError>;
	readonly escalateLaunchPrecondition: (input: {
		readonly runId: string;
		readonly expectedTaskId: string;
		readonly expectedScopeId: string;
		readonly expectedCapability: "triage" | "design" | "execute" | "escalate" | "intake";
		readonly canonicalPath: string;
		readonly agentKind: string;
		readonly reason: string;
		readonly escalationTitle: string;
		readonly escalationBody: string;
	}) => Effect.Effect<void, PdxError>;
	readonly createRepairAlert: (input: {
		readonly runId: string;
		readonly affectedTaskId?: string;
		readonly kind: RepairAlertKind;
		readonly escalationTitle: string;
		readonly escalationBody: string;
	}) => Effect.Effect<void, PdxError>;
	readonly claimableRepairAlertKinds: () => Effect.Effect<readonly RepairAlertKind[], PdxError>;
	readonly briefing: () => Effect.Effect<readonly PithosReadyTask[], PdxError>;
}
export class PithosClient extends Context.Tag("pdx/PithosClient")<
	PithosClient,
	PithosClientService
>() {}

export interface LaunchAgentInput {
	readonly agent: "pandora" | "toil" | "greed" | "war" | "envy";
	readonly mode: "afk" | "hitl";
	readonly runId: string;
	readonly sessionId: string;
	readonly scopeId: string;
	readonly cwd: string;
}

export interface RenderedAgent extends LaunchAgentInput {
	readonly logicalName: string;
	readonly harness: {
		readonly kind: "claude" | "pi";
		readonly argv: readonly string[];
		readonly env: Record<string, string>;
	};
	readonly sessionLogPath: string;
	readonly prompt: string;
}

export interface LaunchAgentResult {
	readonly agent: "pandora" | "toil" | "greed" | "war" | "envy";
	readonly mode: "afk" | "hitl";
	readonly runId: string;
	readonly sessionId: string;
	readonly scopeId: string;
	readonly logicalName: string;
	readonly harnessKind: "claude" | "pi";
	readonly sessionLogPath: string;
	readonly hitl?: { readonly tmuxTarget: string; readonly panePid: number | null };
	readonly afk?: { readonly pid: number; readonly processStartTime: string };
}

export interface SpawnerService {
	readonly materializeTemplates: () => Effect.Effect<void, PdxError>;
	readonly renderAgent: (input: LaunchAgentInput) => Effect.Effect<RenderedAgent, PdxError>;
	readonly launchRenderedAgent: (
		rendered: RenderedAgent,
	) => Effect.Effect<LaunchAgentResult, PdxError>;
	readonly renderSessionTranscript: (input: {
		readonly harnessKind: "claude" | "pi";
		readonly sessionLogPath: string;
		readonly limit: number | undefined;
	}) => Effect.Effect<string, PdxError>;
	readonly loadHooks: () => Effect.Effect<HooksConfig, PdxError>;
}
export class Spawner extends Context.Tag("pdx/Spawner")<Spawner, SpawnerService>() {}

export interface HookChildHandle {
	readonly pid: number;
	readonly waitForLine: Effect.Effect<string | null, PdxError>;
}

export interface HookExecutorService {
	readonly spawn: (
		argv: readonly string[],
		stderrPath: string,
	) => Effect.Effect<HookChildHandle, PdxError>;
	readonly kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void, PdxError>;
	readonly isAlive: (pid: number) => Effect.Effect<boolean, PdxError>;
}
export class HookExecutor extends Context.Tag("pdx/HookExecutor")<
	HookExecutor,
	HookExecutorService
>() {}

export interface RegistryEntry {
	readonly runId: string;
	readonly agent: "pandora" | "toil" | "greed" | "war" | "envy";
	readonly scopeId: string;
	readonly mode: "afk" | "hitl";
	readonly state: "launching" | "live" | "terminating";
	readonly logicalName: string;
	readonly launchedAt?: string;
	readonly everClaimed?: boolean;
	readonly killAttempts?: number;
	readonly killEscalated?: boolean;
	readonly interruptedTaskId?: string;
	readonly killReason?: string;
	readonly pid?: number;
	readonly tmuxTarget?: string;
}

export interface RegistryService {
	readonly list: Effect.Effect<readonly RegistryEntry[]>;
	readonly lastEscalateClaimableCount: Effect.Effect<number>;
	readonly setLastEscalateClaimableCount: (count: number) => Effect.Effect<void>;
	readonly pendingNudgeSince: Effect.Effect<string | null>;
	readonly setPendingNudgeSince: (value: string | null) => Effect.Effect<void>;
	readonly upsert: (entry: RegistryEntry) => Effect.Effect<void>;
	readonly remove: (runId: string) => Effect.Effect<void>;
}
export class Registry extends Context.Tag("pdx/Registry")<Registry, RegistryService>() {}

export const makeRegistry = Effect.gen(function* () {
	const entriesRef = yield* SynchronizedRef.make<readonly RegistryEntry[]>([]);
	const lastEscalateClaimableCountRef = yield* SynchronizedRef.make(0);
	const pendingNudgeSinceRef = yield* SynchronizedRef.make<string | null>(null);
	return Registry.of({
		list: SynchronizedRef.get(entriesRef),
		lastEscalateClaimableCount: SynchronizedRef.get(lastEscalateClaimableCountRef),
		setLastEscalateClaimableCount: (count) =>
			SynchronizedRef.set(lastEscalateClaimableCountRef, count),
		pendingNudgeSince: SynchronizedRef.get(pendingNudgeSinceRef),
		setPendingNudgeSince: (value) => SynchronizedRef.set(pendingNudgeSinceRef, value),
		upsert: (entry) =>
			SynchronizedRef.update(entriesRef, (entries) => [
				...entries.filter((existing) => existing.runId !== entry.runId),
				entry,
			]),
		remove: (runId) =>
			SynchronizedRef.update(entriesRef, (entries) =>
				entries.filter((entry) => entry.runId !== runId),
			),
	});
});

type JsonObject = { readonly [K in string]: JsonValue };

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface SupervisorLogRecord {
	readonly ts: string;
	readonly level: "debug" | "info" | "warn" | "error";
	readonly span: string;
	readonly msg: string;
	readonly data?: JsonObject;
}

export interface SupervisorLogService {
	readonly write: (
		record: Omit<SupervisorLogRecord, "ts">,
	) => Effect.Effect<SupervisorLogRecord, PdxError>;
}
export class SupervisorLog extends Context.Tag("pdx/SupervisorLog")<
	SupervisorLog,
	SupervisorLogService
>() {}

export type NudgeReason = "claimable_escalate" | "task_failed_alert" | "task_dead_lettered_alert";

export type LifecycleEvent =
	| {
			readonly kind: "spawned";
			readonly agent: "pandora" | "toil" | "greed" | "war" | "envy";
			readonly mode: "afk" | "hitl";
			readonly runId: string;
			readonly scopeId: string;
			readonly sessionId: string;
			readonly tmuxTarget?: string | undefined;
			readonly pid?: number | undefined;
	  }
	| {
			readonly kind: "removed";
			readonly agent: "pandora" | "toil" | "greed" | "war" | "envy";
			readonly runId: string;
			readonly scopeId: string;
			readonly reason: "terminated" | "natural_death" | "no_claim_timeout";
			readonly tmuxTarget?: string | undefined;
			readonly pid?: number | undefined;
	  }
	| {
			readonly kind: "nudge";
			readonly reason: NudgeReason;
			readonly target: string;
			readonly claimableEscalateCount: number;
	  }
	| {
			readonly kind: "error";
			readonly span: string;
			readonly message: string;
			readonly attempt: number;
			readonly maxAttempts: number;
	  }
	| {
			readonly kind: "hook_spawned";
			readonly pid: number;
	  }
	| {
			readonly kind: "hook_removed";
			readonly pid: number;
			readonly reason: "shutdown" | "crash";
	  };

export interface LifecycleReporterService {
	readonly report: (event: LifecycleEvent) => Effect.Effect<void, PdxError>;
}
export class LifecycleReporter extends Context.Tag("pdx/LifecycleReporter")<
	LifecycleReporter,
	LifecycleReporterService
>() {}
