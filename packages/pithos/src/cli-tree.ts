import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import type { Config } from "./config.js";
import { runCli } from "./cli.js";
import type { Services } from "./services.js";

export interface CliContext {
	readonly config: Config;
	readonly services: Services;
}

const opt = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value);
const flag = (name: string, value: string | number | undefined): readonly string[] =>
	value === undefined ? [] : [`--${name}`, String(value)];
const bool = (name: string, value: boolean): readonly string[] => (value ? [`--${name}`] : []);
const run = (ctx: CliContext, argv: readonly string[]) =>
	Effect.sync(() => {
		const code = runCli(ctx, argv);
		if (code !== 0) process.exitCode = code;
	});

export const makePithosCommand = (ctx: CliContext) => {
	const init = Command.make("init", { fresh: Options.boolean("fresh") }, ({ fresh }) =>
		run(ctx, ["init", ...bool("fresh", fresh)]),
	);
	const scopeUpsert = Command.make(
		"upsert",
		{
			kind: Options.choice("kind", ["global", "repo", "worktree"] as const),
			path: Options.text("path").pipe(Options.optional),
		},
		({ kind, path }) =>
			run(ctx, ["scope", "upsert", "_", "--kind", kind, ...flag("path", opt(path))]),
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
			run(ctx, [
				"run",
				"upsert",
				"_",
				"--agent",
				o.agent,
				"--mode",
				o.mode,
				"--scope",
				o.scope,
				"--cwd",
				o.cwd,
				"--session-id",
				o.sessionId,
				...flag("run", opt(o.runId)),
			]),
	);
	const runInspect = Command.make("inspect", { id: Args.text({ name: "run-id" }) }, ({ id }) =>
		run(ctx, ["run", "inspect", id]),
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
		(o) =>
			run(ctx, [
				"task",
				"enqueue",
				"_",
				"--scope",
				o.scope,
				"--capability",
				o.capability,
				"--title",
				o.title,
				...flag("body", opt(o.body)),
				...flag("body-file", opt(o.bodyFile)),
				...flag("run", opt(o.runId)),
				...o.dependsOn.flatMap((d) => ["--depends-on", d]),
			]),
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
			run(ctx, [
				"task",
				"claim",
				"_",
				"--run",
				o.runId,
				"--scope",
				o.scope,
				"--capability",
				o.capability,
			]),
	);
	const heartbeat = Command.make(
		"heartbeat",
		{
			runId: Options.text("run"),
			task: Options.text("task").pipe(Options.optional),
			token: Options.integer("token").pipe(Options.optional),
		},
		(o) =>
			run(ctx, [
				"task",
				"heartbeat",
				"_",
				"--run",
				o.runId,
				...flag("task", opt(o.task)),
				...flag("token", opt(o.token)),
			]),
	);
	const complete = Command.make(
		"complete",
		{
			id: Args.text({ name: "task-id" }),
			runId: Options.text("run"),
			token: Options.integer("token"),
			resultFile: Options.text("result-file").pipe(Options.optional),
		},
		(o) =>
			run(ctx, [
				"task",
				"complete",
				o.id,
				"--run",
				o.runId,
				"--token",
				String(o.token),
				...flag("result-file", opt(o.resultFile)),
			]),
	);
	const fail = Command.make(
		"fail",
		{
			id: Args.text({ name: "task-id" }),
			runId: Options.text("run"),
			token: Options.integer("token"),
			reason: Options.text("reason"),
		},
		(o) =>
			run(ctx, [
				"task",
				"fail",
				o.id,
				"--run",
				o.runId,
				"--token",
				String(o.token),
				"--reason",
				o.reason,
			]),
	);
	const inspect = Command.make("inspect", { id: Args.text({ name: "task-id" }) }, ({ id }) =>
		run(ctx, ["task", "inspect", id]),
	);
	const supersede = Command.make(
		"supersede",
		{
			id: Args.text({ name: "task-id" }),
			runId: Options.text("run"),
			reason: Options.text("reason"),
		},
		(o) => run(ctx, ["task", "supersede", o.id, "--run", o.runId, "--reason", o.reason]),
	);
	const cancel = Command.make(
		"cancel",
		{
			id: Args.text({ name: "task-id" }),
			runId: Options.text("run"),
			reason: Options.text("reason"),
		},
		(o) => run(ctx, ["task", "cancel", o.id, "--run", o.runId, "--reason", o.reason]),
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
		(o) =>
			run(ctx, [
				"task",
				"artifact",
				"add",
				"--task",
				o.task,
				"--run",
				o.runId,
				"--kind",
				o.kind,
				"--title",
				o.title,
				...flag("body-file", opt(o.bodyFile)),
			]),
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
		(o) =>
			run(ctx, [
				"graph",
				"inspect",
				"_",
				...flag("task", opt(o.task)),
				...flag("scope", opt(o.scope)),
				...bool("all", o.all),
				...bool("flat", o.flat),
				...bool("dump", o.dump),
			]),
	);
	const graph = Command.make("graph").pipe(Command.withSubcommands([graphInspect]));
	const eventsTail = Command.make(
		"tail",
		{ limit: Options.integer("limit").pipe(Options.optional) },
		(o) => run(ctx, ["events", "tail", "_", ...flag("limit", opt(o.limit))]),
	);
	const events = Command.make("events").pipe(Command.withSubcommands([eventsTail]));
	const briefing = Command.make(
		"briefing",
		{ agent: Options.text("agent").pipe(Options.optional) },
		() => run(ctx, ["briefing"]),
	);
	return Command.make("pithos").pipe(
		Command.withSubcommands([init, scope, runParent, task, graph, events, briefing]),
	);
};
