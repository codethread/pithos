import process from "node:process";
import { inspect } from "node:util";
import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import type { Config } from "./config.js";
import { makeEngine } from "./engine.js";
import { exitCodeFor, PithosError } from "./errors.js";
import type { Mode, ScopeKind } from "./db.js";
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
	| { readonly command: "events.tail"; readonly limit: number | undefined };

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
	return Command.make("pithos-next").pipe(
		Command.withSubcommands([init, scope, runParent, events]),
	);
};
