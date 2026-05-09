import process from "node:process";
import { inspect } from "node:util";
import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import type { Config } from "./config.js";
import { makeEngine } from "./engine.js";
import { exitCodeFor, PithosError } from "./errors.js";
import type { Capability, Mode, ScopeKind } from "./db.js";
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
			readonly sessionId: string;
			readonly runId: string | undefined;
	  }
	| { readonly command: "run.inspect"; readonly runId: string }
	| { readonly command: "events.tail"; readonly limit: number | undefined }
	| {
			readonly command: "task.enqueue";
			readonly scope: string;
			readonly capability: Capability;
			readonly title: string;
			readonly body: string | undefined;
			readonly bodyFile: string | undefined;
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
	  };

const opt = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value);
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

const resolveConfig = (config: Config | (() => Config)): Config =>
	typeof config === "function" ? config() : config;

const runCommand = (ctx: CliContext, input: CommandInput) =>
	Effect.sync(() => {
		try {
			const engine = makeEngine({ config: resolveConfig(ctx.config), services: ctx.services });
			switch (input.command) {
				case "init":
					ctx.services.output.write(json(engine.init({ fresh: input.fresh })));
					return;
				case "scope.upsert":
					ctx.services.output.write(
						json(engine.scopeUpsert({ kind: input.kind, path: input.path })),
					);
					return;
				case "run.upsert":
					ctx.services.output.write(json(engine.runUpsert(input)));
					return;
				case "run.inspect":
					ctx.services.output.write(json(engine.runInspect({ runId: input.runId })));
					return;
				case "events.tail":
					ctx.services.output.write(json(engine.eventsTail({ limit: input.limit })));
					return;
				case "task.enqueue":
					ctx.services.output.write(json(engine.enqueue(input)));
					return;
				case "task.claim":
					ctx.services.output.write(json(engine.claim(input)));
					return;
				case "task.heartbeat":
					ctx.services.output.write(json(engine.heartbeat(input)));
					return;
				case "task.complete":
					ctx.services.output.write(json(engine.complete(input)));
					return;
				case "task.fail":
					ctx.services.output.write(json(engine.failTask(input)));
					return;
				case "task.artifact.add":
					ctx.services.output.write(json(engine.artifactAdd(input)));
					return;
			}
		} catch (error) {
			if (error instanceof PithosError) {
				ctx.services.output.writeError(
					json({ ok: false, error: { code: error.code, message: error.message } }),
				);
				process.exitCode = exitCodeFor(error.code);
				return;
			}
			const message = error instanceof Error ? error.message : inspect(error);
			ctx.services.output.writeError(
				json({ ok: false, error: { code: "INTERNAL_ERROR", message } }),
			);
			process.exitCode = 1;
		}
	});

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
				sessionId: o.sessionId,
				runId: opt(o.runId),
			}),
	);
	const runInspect = Command.make("inspect", { id: Args.text({ name: "run-id" }) }, ({ id }) =>
		runCommand(ctx, { command: "run.inspect", runId: id }),
	);
	const runParent = Command.make("run").pipe(Command.withSubcommands([runUpsert, runInspect]));
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
			body: Options.text("body").pipe(Options.optional),
			bodyFile: Options.text("body-file").pipe(Options.optional),
			runId: Options.text("run").pipe(Options.optional),
			dependsOn: Options.text("depends-on").pipe(Options.repeated),
		},
		(o) =>
			runCommand(ctx, {
				command: "task.enqueue",
				scope: o.scope,
				capability: o.capability,
				title: o.title,
				body: opt(o.body),
				bodyFile: opt(o.bodyFile),
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
	const task = Command.make("task").pipe(
		Command.withSubcommands([
			taskEnqueue,
			taskClaim,
			taskHeartbeat,
			taskComplete,
			taskFail,
			taskArtifact,
		]),
	);
	return Command.make("pithos-next").pipe(
		Command.withSubcommands([init, scope, runParent, task, events]),
	);
};
