import process from "node:process";
import { inspect } from "node:util";
import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import type { Config } from "./config.js";
import { makeEngine } from "./engine.js";
import { exitCodeFor, PithosError } from "./errors.js";
import type { Capability, HarnessKind, Mode, ScopeKind } from "./db.js";
import type { Services } from "./services.js";

export interface CliContext {
	readonly config: Config | (() => Config);
	readonly services: Services;
}

type CommandInput =
	| { readonly command: "init"; readonly fresh: boolean }
	| {
			readonly command: "scope.upsert";
			readonly kind: ScopeKind;
			readonly path: string | undefined;
	  }
	| {
			readonly command: "run.upsert";
			readonly agent: string;
			readonly mode: Mode;
			readonly scope: string;
			readonly cwd: string;
			readonly harnessKind: HarnessKind;
			readonly sessionLogPath: string;
			readonly sessionId: string;
			readonly runId: string | undefined;
	  }
	| { readonly command: "run.inspect"; readonly runId: string }
	| { readonly command: "run.cleanup"; readonly runId: string; readonly reason: string }
	| {
			readonly command: "run.interrupt";
			readonly runId: string | undefined;
			readonly taskId: string | undefined;
			readonly reason: string;
	  }
	| { readonly command: "run.timeout"; readonly runId: string; readonly reason: string }
	| { readonly command: "events.tail"; readonly limit: number | undefined }
	| {
			readonly command: "task.enqueue";
			readonly scope: string;
			readonly capability: Capability;
			readonly title: string;
			readonly stdin: boolean;
			readonly runId: string | undefined;
			readonly dependsOn: readonly string[];
	  }
	| {
			readonly command: "task.claim";
			readonly runId: string | undefined;
			readonly scope: string;
			readonly capability: Capability;
	  }
	| {
			readonly command: "task.heartbeat";
			readonly runId: string | undefined;
			readonly taskId: string | undefined;
			readonly token: number | undefined;
	  }
	| {
			readonly command: "task.complete";
			readonly taskId: string;
			readonly runId: string | undefined;
			readonly token: number;
			readonly resultFile: string | undefined;
	  }
	| {
			readonly command: "task.fail";
			readonly taskId: string;
			readonly runId: string | undefined;
			readonly token: number;
			readonly reason: string;
	  }
	| {
			readonly command: "task.artifact.add";
			readonly taskId: string;
			readonly runId: string | undefined;
			readonly kind: string;
			readonly title: string;
			readonly bodyFile: string | undefined;
	  }
	| { readonly command: "task.inspect"; readonly taskId: string }
	| {
			readonly command: "task.cancel";
			readonly taskId: string;
			readonly runId: string | undefined;
			readonly reason: string;
	  }
	| {
			readonly command: "task.supersede";
			readonly taskId: string;
			readonly runId: string | undefined;
			readonly reason: string;
			readonly title: string | undefined;
			readonly body: string | undefined;
			readonly bodyFile: string | undefined;
			readonly scope: string | undefined;
			readonly capability: Capability | undefined;
	  }
	| {
			readonly command: "graph.inspect";
			readonly taskId: string | undefined;
			readonly scope: string | undefined;
			readonly all: boolean;
			readonly flat: boolean;
			readonly dump: boolean;
	  }
	| { readonly command: "briefing"; readonly agent: string | undefined };

const opt = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value);
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

const resolveConfig = (config: Config | (() => Config)): Config =>
	typeof config === "function" ? config() : config;

const fromEngine = <A>(thunk: () => A): Effect.Effect<A, PithosError> =>
	Effect.try({
		try: thunk,
		catch: (error) =>
			error instanceof PithosError
				? error
				: new PithosError({
						code: "INTERNAL_ERROR",
						message: error instanceof Error ? error.message : inspect(error),
					}),
	});

const readRequiredStdinBody = (ctx: CliContext): Effect.Effect<string, PithosError> =>
	Effect.gen(function* () {
		const stdin = yield* ctx.services.input.readStdin();
		switch (stdin._tag) {
			case "NoRedirectedStdin":
				return yield* Effect.fail(
					new PithosError({
						code: "VALIDATION_ERROR",
						message: "--stdin requires redirected stdin",
					}),
				);
			case "ReadFailure":
				return yield* Effect.fail(stdin.error);
			case "RedirectedText":
				if (stdin.text.length === 0) {
					return yield* Effect.fail(
						new PithosError({ code: "VALIDATION_ERROR", message: "stdin body must be non-empty" }),
					);
				}
				return stdin.text;
		}
	});

const runCommand = (ctx: CliContext, input: CommandInput) =>
	Effect.gen(function* () {
		const writeJson = (value: unknown) => ctx.services.output.write(json(value));
		const enqueueBody =
			input.command === "task.enqueue"
				? input.stdin
					? yield* readRequiredStdinBody(ctx)
					: yield* Effect.fail(
							new PithosError({
								code: "VALIDATION_ERROR",
								message: "task enqueue requires --stdin",
							}),
						)
				: undefined;
		const engine = makeEngine({ config: resolveConfig(ctx.config), services: ctx.services });
		const result = yield* fromEngine(() => {
			switch (input.command) {
				case "init":
					return engine.init({ fresh: input.fresh });
				case "scope.upsert":
					return engine.scopeUpsert({ kind: input.kind, path: input.path });
				case "run.upsert":
					return engine.runUpsert(input);
				case "run.inspect":
					return engine.runInspect({ runId: input.runId });
				case "run.cleanup":
					return engine.runCleanup(input);
				case "run.interrupt":
					return engine.runInterrupt(input);
				case "run.timeout":
					return engine.runTimeout(input);
				case "events.tail":
					return engine.eventsTail({ limit: input.limit });
				case "task.enqueue":
					return engine.enqueue({ ...input, body: enqueueBody, bodyFile: undefined });
				case "task.claim":
					return engine.claim(input);
				case "task.heartbeat":
					return engine.heartbeat(input);
				case "task.complete":
					return engine.complete(input);
				case "task.fail":
					return engine.failTask(input);
				case "task.artifact.add":
					return engine.artifactAdd(input);
				case "task.inspect":
					return engine.taskInspect({ taskId: input.taskId });
				case "task.cancel":
					return engine.cancel(input);
				case "task.supersede":
					return engine.supersede(input);
				case "graph.inspect":
					return engine.graphInspect(input);
				case "briefing":
					return engine.briefing({ agent: input.agent });
			}
		});
		yield* typeof result === "string" ? ctx.services.output.write(result) : writeJson(result);
	}).pipe(
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				yield* ctx.services.output.writeError(
					json({ ok: false, error: { code: error.code, message: error.message } }),
				);
				process.exitCode = exitCodeFor(error.code);
			}),
		),
	);

export const makePithosCommand = (ctx: CliContext) => {
	const init = Command.make("init", { fresh: Options.boolean("fresh") }, ({ fresh }) =>
		runCommand(ctx, { command: "init", fresh }),
	);
	const scopeUpsert = Command.make(
		"upsert",
		{
			kind: Options.choice("kind", ["global", "repo", "worktree"] as const),
			path: Options.text("path").pipe(Options.optional),
		},
		({ kind, path }) => runCommand(ctx, { command: "scope.upsert", kind, path: opt(path) }),
	);
	const scope = Command.make("scope").pipe(Command.withSubcommands([scopeUpsert]));
	const runUpsert = Command.make(
		"upsert",
		{
			agent: Options.text("agent"),
			mode: Options.choice("mode", ["afk", "hitl"] as const),
			scope: Options.text("scope"),
			cwd: Options.text("cwd"),
			harnessKind: Options.choice("harness-kind", ["claude", "pi", "system"] as const),
			sessionLogPath: Options.text("session-log-path"),
			sessionId: Options.text("session-id"),
			runId: Options.text("run").pipe(Options.optional),
		},
		(o) =>
			runCommand(ctx, {
				command: "run.upsert",
				agent: o.agent,
				mode: o.mode,
				scope: o.scope,
				cwd: o.cwd,
				harnessKind: o.harnessKind,
				sessionLogPath: o.sessionLogPath,
				sessionId: o.sessionId,
				runId: opt(o.runId),
			}),
	);
	const runInspect = Command.make("inspect", { id: Args.text({ name: "run-id" }) }, ({ id }) =>
		runCommand(ctx, { command: "run.inspect", runId: id }),
	);
	const runCleanup = Command.make(
		"cleanup",
		{ runId: Options.text("run"), reason: Options.text("reason") },
		({ runId, reason }) => runCommand(ctx, { command: "run.cleanup", runId, reason }),
	);
	const runInterrupt = Command.make(
		"interrupt",
		{
			runId: Options.text("run").pipe(Options.optional),
			taskId: Options.text("task").pipe(Options.optional),
			reason: Options.text("reason"),
		},
		(o) =>
			runCommand(ctx, {
				command: "run.interrupt",
				runId: opt(o.runId),
				taskId: opt(o.taskId),
				reason: o.reason,
			}),
	);
	const runTimeout = Command.make(
		"timeout",
		{ runId: Options.text("run"), reason: Options.text("reason") },
		({ runId, reason }) => runCommand(ctx, { command: "run.timeout", runId, reason }),
	);
	const runParent = Command.make("run").pipe(
		Command.withSubcommands([runUpsert, runInspect, runCleanup, runInterrupt, runTimeout]),
	);
	const eventsTail = Command.make(
		"tail",
		{ limit: Options.integer("limit").pipe(Options.optional) },
		({ limit }) => runCommand(ctx, { command: "events.tail", limit: opt(limit) }),
	);
	const events = Command.make("events").pipe(Command.withSubcommands([eventsTail]));
	const capability = Options.choice("capability", [
		"triage",
		"design",
		"execute",
		"escalate",
	] as const);
	const taskEnqueue = Command.make(
		"enqueue",
		{
			scope: Options.text("scope"),
			capability,
			title: Options.text("title"),
			stdin: Options.boolean("stdin"),
			runId: Options.text("run").pipe(Options.optional),
			dependsOn: Options.text("depends-on").pipe(Options.repeated),
		},
		(o) =>
			runCommand(ctx, {
				command: "task.enqueue",
				scope: o.scope,
				capability: o.capability,
				title: o.title,
				stdin: o.stdin,
				runId: opt(o.runId),
				dependsOn: o.dependsOn,
			}),
	);
	const taskClaim = Command.make(
		"claim",
		{ runId: Options.text("run").pipe(Options.optional), scope: Options.text("scope"), capability },
		(o) =>
			runCommand(ctx, {
				command: "task.claim",
				runId: opt(o.runId),
				scope: o.scope,
				capability: o.capability,
			}),
	);
	const taskHeartbeat = Command.make(
		"heartbeat",
		{
			runId: Options.text("run").pipe(Options.optional),
			taskId: Options.text("task").pipe(Options.optional),
			token: Options.integer("token").pipe(Options.optional),
		},
		(o) =>
			runCommand(ctx, {
				command: "task.heartbeat",
				runId: opt(o.runId),
				taskId: opt(o.taskId),
				token: opt(o.token),
			}),
	);
	const taskComplete = Command.make(
		"complete",
		{
			taskId: Args.text({ name: "task-id" }),
			runId: Options.text("run").pipe(Options.optional),
			token: Options.integer("token"),
			resultFile: Options.text("result-file").pipe(Options.optional),
		},
		(o) =>
			runCommand(ctx, {
				command: "task.complete",
				taskId: o.taskId,
				runId: opt(o.runId),
				token: o.token,
				resultFile: opt(o.resultFile),
			}),
	);
	const taskFail = Command.make(
		"fail",
		{
			taskId: Args.text({ name: "task-id" }),
			runId: Options.text("run").pipe(Options.optional),
			token: Options.integer("token"),
			reason: Options.text("reason"),
		},
		(o) =>
			runCommand(ctx, {
				command: "task.fail",
				taskId: o.taskId,
				runId: opt(o.runId),
				token: o.token,
				reason: o.reason,
			}),
	);
	const artifactAdd = Command.make(
		"add",
		{
			taskId: Options.text("task"),
			runId: Options.text("run").pipe(Options.optional),
			kind: Options.text("kind"),
			title: Options.text("title"),
			bodyFile: Options.text("body-file").pipe(Options.optional),
		},
		(o) =>
			runCommand(ctx, {
				command: "task.artifact.add",
				taskId: o.taskId,
				runId: opt(o.runId),
				kind: o.kind,
				title: o.title,
				bodyFile: opt(o.bodyFile),
			}),
	);
	const taskArtifact = Command.make("artifact").pipe(Command.withSubcommands([artifactAdd]));
	const taskInspect = Command.make("inspect", { taskId: Args.text({ name: "task-id" }) }, (o) =>
		runCommand(ctx, { command: "task.inspect", taskId: o.taskId }),
	);
	const taskCancel = Command.make(
		"cancel",
		{
			taskId: Args.text({ name: "task-id" }),
			runId: Options.text("run").pipe(Options.optional),
			reason: Options.text("reason"),
		},
		(o) =>
			runCommand(ctx, {
				command: "task.cancel",
				taskId: o.taskId,
				runId: opt(o.runId),
				reason: o.reason,
			}),
	);
	const taskSupersede = Command.make(
		"supersede",
		{
			taskId: Args.text({ name: "task-id" }),
			runId: Options.text("run").pipe(Options.optional),
			reason: Options.text("reason"),
			title: Options.text("title").pipe(Options.optional),
			body: Options.text("body").pipe(Options.optional),
			bodyFile: Options.text("body-file").pipe(Options.optional),
			scope: Options.text("scope").pipe(Options.optional),
			capability: capability.pipe(Options.optional),
		},
		(o) =>
			runCommand(ctx, {
				command: "task.supersede",
				taskId: o.taskId,
				runId: opt(o.runId),
				reason: o.reason,
				title: opt(o.title),
				body: opt(o.body),
				bodyFile: opt(o.bodyFile),
				scope: opt(o.scope),
				capability: opt(o.capability),
			}),
	);
	const task = Command.make("task").pipe(
		Command.withSubcommands([
			taskEnqueue,
			taskClaim,
			taskHeartbeat,
			taskComplete,
			taskFail,
			taskInspect,
			taskCancel,
			taskSupersede,
			taskArtifact,
		]),
	);
	const graphInspect = Command.make(
		"inspect",
		{
			taskId: Options.text("task").pipe(Options.optional),
			scope: Options.text("scope").pipe(Options.optional),
			all: Options.boolean("all"),
			flat: Options.boolean("flat"),
			dump: Options.boolean("dump"),
		},
		(o) =>
			runCommand(ctx, {
				command: "graph.inspect",
				taskId: opt(o.taskId),
				scope: opt(o.scope),
				all: o.all,
				flat: o.flat,
				dump: o.dump,
			}),
	);
	const graph = Command.make("graph").pipe(Command.withSubcommands([graphInspect]));
	const briefing = Command.make(
		"briefing",
		{ agent: Options.text("agent").pipe(Options.optional) },
		(o) => runCommand(ctx, { command: "briefing", agent: opt(o.agent) }),
	);
	return Command.make("pithos").pipe(
		Command.withSubcommands([init, scope, runParent, task, graph, events, briefing]),
	);
};
