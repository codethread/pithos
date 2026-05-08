import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import type { Config } from "./config.js";
import { makeEngine } from "./engine.js";
import { exitCodeFor, PithosError } from "./errors.js";
import type { Services } from "./services.js";

export interface CliContext {
	readonly config: Config;
	readonly services: Services;
}

const opt = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value);
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

const writeResult = (ctx: CliContext, run: () => unknown) =>
	Effect.sync(() => {
		try {
			ctx.services.output.write(json(run()));
		} catch (error) {
			if (error instanceof PithosError) {
				ctx.services.output.writeError(
					json({ ok: false, error: { code: error.code, message: error.message } }),
				);
				process.exitCode = exitCodeFor(error.code);
				return;
			}
			throw error;
		}
	});

const notImplemented = (ctx: CliContext, command: string) =>
	writeResult(ctx, () => {
		throw new PithosError({
			code: "VALIDATION_ERROR",
			message: `${command} is not implemented in pithos-next yet`,
		});
	});

export const makePithosCommand = (ctx: CliContext) => {
	const engine = makeEngine(ctx);
	const init = Command.make("init", { fresh: Options.boolean("fresh") }, ({ fresh }) =>
		writeResult(ctx, () => engine.init({ fresh })),
	);
	const scopeUpsert = Command.make(
		"upsert",
		{
			kind: Options.choice("kind", ["global", "repo", "worktree"] as const),
			path: Options.text("path").pipe(Options.optional),
		},
		({ kind, path }) => writeResult(ctx, () => engine.scopeUpsert({ kind, path: opt(path) })),
	);
	const scope = Command.make("scope").pipe(Command.withSubcommands([scopeUpsert]));
	const runUpsert = Command.make(
		"upsert",
		{
			agent: Options.choice("agent", ["pdx", "pandora", "toil", "greed", "war"] as const),
			mode: Options.choice("mode", ["afk", "hitl"] as const),
			scope: Options.text("scope"),
			cwd: Options.text("cwd"),
			sessionId: Options.text("session-id"),
			runId: Options.text("run").pipe(Options.optional),
		},
		(o) =>
			writeResult(ctx, () =>
				engine.runUpsert({
					agent: o.agent,
					mode: o.mode,
					scope: o.scope,
					cwd: o.cwd,
					sessionId: o.sessionId,
					runId: opt(o.runId),
				}),
			),
	);
	const runInspect = Command.make("inspect", { id: Args.text({ name: "run-id" }) }, () =>
		notImplemented(ctx, "run inspect"),
	);
	const runParent = Command.make("run").pipe(Command.withSubcommands([runUpsert, runInspect]));
	const enqueue = Command.make(
		"enqueue",
		{
			scope: Options.text("scope"),
			capability: Options.choice("capability", [
				"triage",
				"design",
				"execute",
				"escalate",
			] as const),
			title: Options.text("title"),
			body: Options.text("body").pipe(Options.optional),
			bodyFile: Options.text("body-file").pipe(Options.optional),
			runId: Options.text("run").pipe(Options.optional),
			dependsOn: Options.text("depends-on").pipe(Options.repeated),
		},
		() => notImplemented(ctx, "task enqueue"),
	);
	const claim = Command.make(
		"claim",
		{
			runId: Options.text("run"),
			scope: Options.text("scope"),
			capability: Options.choice("capability", [
				"triage",
				"design",
				"execute",
				"escalate",
			] as const),
		},
		(o) =>
			writeResult(ctx, () =>
				engine.claim({ runId: o.runId, scope: o.scope, capability: o.capability }),
			),
	);
	const heartbeat = Command.make(
		"heartbeat",
		{
			runId: Options.text("run"),
			task: Options.text("task").pipe(Options.optional),
			token: Options.integer("token").pipe(Options.optional),
		},
		() => notImplemented(ctx, "task heartbeat"),
	);
	const complete = Command.make(
		"complete",
		{
			id: Args.text({ name: "task-id" }),
			runId: Options.text("run"),
			token: Options.integer("token"),
			resultFile: Options.text("result-file").pipe(Options.optional),
		},
		() => notImplemented(ctx, "task complete"),
	);
	const fail = Command.make(
		"fail",
		{
			id: Args.text({ name: "task-id" }),
			runId: Options.text("run"),
			token: Options.integer("token"),
			reason: Options.text("reason"),
		},
		() => notImplemented(ctx, "task fail"),
	);
	const inspect = Command.make("inspect", { id: Args.text({ name: "task-id" }) }, () =>
		notImplemented(ctx, "task inspect"),
	);
	const supersede = Command.make(
		"supersede",
		{
			id: Args.text({ name: "task-id" }),
			runId: Options.text("run"),
			reason: Options.text("reason"),
		},
		() => notImplemented(ctx, "task supersede"),
	);
	const cancel = Command.make(
		"cancel",
		{
			id: Args.text({ name: "task-id" }),
			runId: Options.text("run"),
			reason: Options.text("reason"),
		},
		() => notImplemented(ctx, "task cancel"),
	);
	const artifactAdd = Command.make(
		"add",
		{
			task: Options.text("task"),
			runId: Options.text("run"),
			kind: Options.text("kind"),
			title: Options.text("title"),
			bodyFile: Options.text("body-file").pipe(Options.optional),
		},
		() => notImplemented(ctx, "task artifact add"),
	);
	const artifact = Command.make("artifact").pipe(Command.withSubcommands([artifactAdd]));
	const task = Command.make("task").pipe(
		Command.withSubcommands([
			enqueue,
			claim,
			heartbeat,
			complete,
			fail,
			supersede,
			cancel,
			inspect,
			artifact,
		]),
	);
	const graphInspect = Command.make(
		"inspect",
		{
			task: Options.text("task").pipe(Options.optional),
			scope: Options.text("scope").pipe(Options.optional),
			all: Options.boolean("all"),
			flat: Options.boolean("flat"),
			dump: Options.boolean("dump"),
		},
		() => notImplemented(ctx, "graph inspect"),
	);
	const graph = Command.make("graph").pipe(Command.withSubcommands([graphInspect]));
	const eventsTail = Command.make(
		"tail",
		{ limit: Options.integer("limit").pipe(Options.optional) },
		() => notImplemented(ctx, "events tail"),
	);
	const events = Command.make("events").pipe(Command.withSubcommands([eventsTail]));
	const briefing = Command.make(
		"briefing",
		{ agent: Options.text("agent").pipe(Options.optional) },
		() => notImplemented(ctx, "briefing"),
	);
	return Command.make("pithos").pipe(
		Command.withSubcommands([init, scope, runParent, task, graph, events, briefing]),
	);
};
