import process from "node:process";
import { inspect } from "node:util";
import { Args, CliConfig, Command, CommandDescriptor, Options, Usage } from "@effect/cli";
import type { HelpDoc, Span } from "@effect/cli";
import { Effect, Layer, Option } from "effect";
import { NodeContext } from "@effect/platform-node";
import type { Config } from "./config.js";
import {
	makeEngine,
	renderBriefingText,
	renderGraphInspectText,
	renderTaskInspectMarkdown,
} from "./engine.js";
import { exitCodeFor, PithosError } from "./errors.js";
import type { ChainPolicy } from "./chain-policy.js";
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
			readonly description?: string | undefined;
	  }
	| { readonly command: "scope.list"; readonly all: boolean }
	| { readonly command: "scope.archive"; readonly scopeId: string }
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
			readonly chain: string;
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
			readonly stdin: boolean;
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
			readonly stdin: boolean;
	  }
	| { readonly command: "task.inspect"; readonly taskId: string; readonly json: boolean }
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
			readonly stdin: boolean;
			readonly scope: string | undefined;
			readonly capability: Capability | undefined;
	  }
	| {
			readonly command: "graph.inspect";
			readonly taskId: string | undefined;
			readonly scope: string | undefined;
			readonly all: boolean;
			readonly hideTerminal: boolean;
			readonly json: boolean;
	  }
	| { readonly command: "briefing"; readonly agent: string | undefined; readonly json: boolean };

const opt = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value);
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

export interface PithosHelpCommand {
	readonly tool: "pithos";
	readonly name: string;
	readonly path: string;
	readonly usage: string;
	readonly description: string;
	readonly subcommands: readonly PithosHelpCommand[];
}

type CommandDescriptorNode =
	| {
			readonly _tag: "Standard" | "GetUserInput";
			readonly name: string;
			readonly description: HelpDoc.HelpDoc;
	  }
	| { readonly _tag: "Map"; readonly command: CommandDescriptorNode }
	| {
			readonly _tag: "Subcommands";
			readonly parent: CommandDescriptorNode;
			readonly children: readonly CommandDescriptorNode[];
	  };

const HELP_CLI_CONFIG = CliConfig.make({ showBuiltIns: false });

const spanToText = (span: Span.Span): string => {
	switch (span._tag) {
		case "Text":
			return span.value;
		case "URI":
			return span.value;
		case "Sequence":
			return `${spanToText(span.left)}${spanToText(span.right)}`;
		case "Highlight":
		case "Strong":
		case "Weak":
			return spanToText(span.value);
	}
};

const helpDocToText = (helpDoc: HelpDoc.HelpDoc): string => {
	switch (helpDoc._tag) {
		case "Empty":
			return "";
		case "Header":
		case "Paragraph":
			return spanToText(helpDoc.value);
		case "DescriptionList":
			return helpDoc.definitions
				.map(([term, definition]) => `${spanToText(term)} ${helpDocToText(definition)}`.trim())
				.join("\n");
		case "Enumeration":
			return helpDoc.elements.map(helpDocToText).join("\n");
		case "Sequence": {
			const left = helpDocToText(helpDoc.left);
			const right = helpDocToText(helpDoc.right);
			return [left, right].filter((part) => part.length > 0).join("\n");
		}
	}
};

const unwrapCommandDescriptorMap = (node: CommandDescriptorNode): CommandDescriptorNode =>
	node._tag === "Map" ? unwrapCommandDescriptorMap(node.command) : node;

const commandDescriptorName = (node: CommandDescriptorNode): string => {
	const unwrapped = unwrapCommandDescriptorMap(node);
	switch (unwrapped._tag) {
		case "Standard":
		case "GetUserInput":
			return unwrapped.name;
		case "Subcommands":
			return commandDescriptorName(unwrapped.parent);
		case "Map":
			return commandDescriptorName(unwrapped.command);
	}
};

const commandDescriptorDescription = (node: CommandDescriptorNode): string => {
	const unwrapped = unwrapCommandDescriptorMap(node);
	switch (unwrapped._tag) {
		case "Standard":
		case "GetUserInput":
			return helpDocToText(unwrapped.description);
		case "Subcommands":
			return commandDescriptorDescription(unwrapped.parent);
		case "Map":
			return commandDescriptorDescription(unwrapped.command);
	}
};

const commandDescriptorUsage = (node: CommandDescriptorNode): string => {
	const unwrapped = unwrapCommandDescriptorMap(node);
	const usageNode = unwrapped._tag === "Subcommands" ? unwrapped.parent : unwrapped;
	const usage = Usage.enumerate(
		CommandDescriptor.getUsage(usageNode as unknown as CommandDescriptor.Command<unknown>),
		HELP_CLI_CONFIG,
	)
		.map(spanToText)
		.join(" | ");
	return unwrapped._tag === "Subcommands" ? `${usage} <command>` : usage;
};

const renderHelpCommand = (
	node: CommandDescriptorNode,
	parentPath: readonly string[],
): PithosHelpCommand => {
	const unwrapped = unwrapCommandDescriptorMap(node);
	const name = commandDescriptorName(unwrapped);
	const path = [...parentPath, name];
	const children =
		unwrapped._tag === "Subcommands"
			? unwrapped.children.map((child) => renderHelpCommand(child, path))
			: [];
	return {
		tool: "pithos",
		name,
		path: path.join(" "),
		usage: commandDescriptorUsage(unwrapped),
		description: commandDescriptorDescription(unwrapped),
		subcommands: children,
	};
};

export const renderPithosHelpJson = <Name extends string, R, E, A>(
	command: Command.Command<Name, R, E, A>,
): string => json(renderHelpCommand(command.descriptor as unknown as CommandDescriptorNode, []));

const handleHelpJson = <Name extends string, R, E, A>(
	ctx: CliContext,
	args: readonly string[],
	command: Command.Command<Name, R, E, A>,
): Effect.Effect<boolean> => {
	const cliArgs = args.slice(2);
	if (!cliArgs.includes("--help-json")) return Effect.succeed(false);
	if (cliArgs.length !== 1) {
		return ctx.services.output
			.writeError(
				json({
					ok: false,
					error: {
						code: "VALIDATION_ERROR",
						message: "--help-json must be the only pithos argument",
					},
				}),
			)
			.pipe(
				Effect.zipRight(
					Effect.sync(() => void (process.exitCode = exitCodeFor("VALIDATION_ERROR"))),
				),
				Effect.as(true),
			);
	}
	return ctx.services.output.write(renderPithosHelpJson(command)).pipe(Effect.as(true));
};

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

const readStdinText = (ctx: CliContext) =>
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

const readRequiredStdinBody = (ctx: CliContext, command: string, enabled: boolean) =>
	Effect.gen(function* () {
		if (!enabled) {
			return yield* Effect.fail(
				new PithosError({ code: "VALIDATION_ERROR", message: `${command} requires --stdin` }),
			);
		}
		return yield* readStdinText(ctx);
	});

const parseResultMetadata = (text: string): string => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		throw new PithosError({
			code: "VALIDATION_ERROR",
			message: "stdin result metadata must be valid JSON object",
		});
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new PithosError({
			code: "VALIDATION_ERROR",
			message: "stdin result metadata must be a JSON object",
		});
	}
	return JSON.stringify(parsed);
};

const readOptionalResultMetadata = (ctx: CliContext, enabled: boolean) =>
	Effect.gen(function* () {
		if (!enabled) return "{}";
		const text = yield* readStdinText(ctx);
		return yield* fromEngine(() => parseResultMetadata(text));
	});

const runCommand = (ctx: CliContext, input: CommandInput) =>
	Effect.gen(function* () {
		const writeJson = (value: unknown) => ctx.services.output.write(json(value));
		const enqueueChain =
			input.command === "task.enqueue"
				? yield* fromEngine(() => parseChainPolicy(input.chain))
				: undefined;
		const enqueueBody =
			input.command === "task.enqueue"
				? yield* readRequiredStdinBody(ctx, "task enqueue", input.stdin)
				: undefined;
		const supersedeBody =
			input.command === "task.supersede"
				? yield* readRequiredStdinBody(ctx, "task supersede", input.stdin)
				: undefined;
		const artifactBody =
			input.command === "task.artifact.add"
				? yield* readRequiredStdinBody(ctx, "task artifact add", input.stdin)
				: undefined;
		const completeResult =
			input.command === "task.complete"
				? yield* readOptionalResultMetadata(ctx, input.stdin)
				: undefined;
		const engine = makeEngine({ config: resolveConfig(ctx.config), services: ctx.services });
		const result = yield* fromEngine(() => {
			switch (input.command) {
				case "init":
					return engine.init({ fresh: input.fresh });
				case "scope.upsert":
					return engine.scopeUpsert({
						kind: input.kind,
						path: input.path,
						description: input.description,
					});
				case "scope.list":
					return engine.scopeList({ all: input.all });
				case "scope.archive":
					return engine.scopeArchive({ scopeId: input.scopeId });
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
					return engine.enqueue({
						...input,
						chain: enqueueChain!,
						body: enqueueBody,
						bodyFile: undefined,
					});
				case "task.claim":
					return engine.claim(input);
				case "task.heartbeat":
					return engine.heartbeat(input);
				case "task.complete":
					return engine.complete({ ...input, resultJson: completeResult! });
				case "task.fail":
					return engine.failTask(input);
				case "task.artifact.add":
					return engine.artifactAdd({ ...input, body: artifactBody! });
				case "task.inspect": {
					const inspectOutput = engine.taskInspect({ taskId: input.taskId });
					return input.json ? inspectOutput : renderTaskInspectMarkdown(inspectOutput);
				}
				case "task.cancel":
					return engine.cancel(input);
				case "task.supersede":
					return engine.supersede({ ...input, body: supersedeBody, bodyFile: undefined });
				case "graph.inspect": {
					const graphOutput = engine.graphInspect(input);
					return input.json ? graphOutput : renderGraphInspectText(graphOutput);
				}
				case "briefing": {
					const briefingOutput = engine.briefing({ agent: input.agent });
					return input.json ? briefingOutput : renderBriefingText(briefingOutput);
				}
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

const runIdOption = Options.text("run").pipe(
	Options.withDescription("Pithos run id for the agent run making or owning this transition."),
);
const taskIdOption = Options.text("task").pipe(
	Options.withDescription("Pithos task id for the held task or graph root."),
);
const reasonOption = Options.text("reason").pipe(
	Options.withDescription("Operator-readable reason recorded in Pithos events."),
);
const stdinFlag = Options.boolean("stdin").pipe(
	Options.withDescription("Read the task or artifact body from stdin."),
);
const chainOption = Options.text("chain").pipe(
	Options.withDescription(
		"Task chaining policy: auto (default), none (manual-only), or advanced fail-loud held/source.",
	),
	Options.withDefault("auto"),
);

const parseChainPolicy = (value: string): ChainPolicy => {
	if ((["auto", "none", "held", "source"] as const).includes(value as ChainPolicy)) {
		return value as ChainPolicy;
	}
	throw new PithosError({
		code: "VALIDATION_ERROR",
		message: `Invalid --chain value: '${value}'. Valid values: auto, none, held, source`,
	});
};

export const makePithosCommand = (ctx: CliContext) => {
	const init = Command.make(
		"init",
		{
			fresh: Options.boolean("fresh").pipe(
				Options.withDescription(
					"Remove any existing Pithos database before creating schema and seed data.",
				),
			),
		},
		({ fresh }) => runCommand(ctx, { command: "init", fresh }),
	).pipe(
		Command.withDescription("Create the Pithos database schema and seed built-in agent kinds."),
	);
	const scopeUpsert = Command.make(
		"upsert",
		{
			kind: Options.choice("kind", ["global", "repo", "worktree"] as const).pipe(
				Options.withDescription("Scope kind: global, repository, or worktree."),
			),
			path: Options.text("path").pipe(
				Options.withDescription("Filesystem path for repo/worktree scopes; omit for global scope."),
				Options.optional,
			),
			description: Options.text("description").pipe(
				Options.withDescription("Optional human-readable description for operator context."),
				Options.optional,
			),
		},
		({ kind, path, description }) =>
			runCommand(ctx, {
				command: "scope.upsert",
				kind,
				path: opt(path),
				description: opt(description),
			}),
	).pipe(Command.withDescription("Create or update a durable Pithos scope."));
	const scopeList = Command.make(
		"list",
		{
			all: Options.boolean("all").pipe(
				Options.withDescription("Include archived scopes alongside active scopes."),
			),
		},
		({ all }) => runCommand(ctx, { command: "scope.list", all }),
	).pipe(
		Command.withDescription("List durable Pithos scopes with task/run counts and archive state."),
	);
	const scopeArchive = Command.make("archive", { id: Args.text({ name: "scope-id" }) }, ({ id }) =>
		runCommand(ctx, { command: "scope.archive", scopeId: id }),
	).pipe(
		Command.withDescription(
			"Archive one durable Pithos scope, or delete it if nothing has ever referenced it.",
		),
	);
	const scope = Command.make("scope").pipe(
		Command.withDescription("Manage durable Pithos scopes used to partition task queues."),
		Command.withSubcommands([scopeUpsert, scopeList, scopeArchive]),
	);
	const runUpsert = Command.make(
		"upsert",
		{
			agent: Options.text("agent").pipe(
				Options.withDescription(
					"Agent kind for this run, for example pandora, toil, greed, or war.",
				),
			),
			mode: Options.choice("mode", ["afk", "hitl"] as const).pipe(
				Options.withDescription("Supervision mode: AFK process or HITL tmux session."),
			),
			scope: Options.text("scope").pipe(
				Options.withDescription("Pithos scope id this run belongs to."),
			),
			cwd: Options.text("cwd").pipe(
				Options.withDescription("Working directory the harness should run in."),
			),
			harnessKind: Options.choice("harness-kind", ["claude", "pi", "system"] as const).pipe(
				Options.withDescription("Underlying harness runtime used by the agent run."),
			),
			sessionLogPath: Options.text("session-log-path").pipe(
				Options.withDescription("JSONL harness session log path for agent-facing observability."),
			),
			sessionId: Options.text("session-id").pipe(
				Options.withDescription("Harness session id assigned by the launcher."),
			),
			runId: runIdOption.pipe(Options.optional),
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
	).pipe(Command.withDescription("Create or update the durable run row for one agent invocation."));
	const runInspect = Command.make("inspect", { id: Args.text({ name: "run-id" }) }, ({ id }) =>
		runCommand(ctx, { command: "run.inspect", runId: id }),
	).pipe(Command.withDescription("Show one durable Pithos run record."));
	const runCleanup = Command.make(
		"cleanup",
		{ runId: runIdOption, reason: reasonOption },
		({ runId, reason }) => runCommand(ctx, { command: "run.cleanup", runId, reason }),
	).pipe(
		Command.withDescription(
			"Mark a naturally ended agent run as cleaned up and release any held task.",
		),
	);
	const runInterrupt = Command.make(
		"interrupt",
		{
			runId: runIdOption.pipe(Options.optional),
			taskId: taskIdOption.pipe(Options.optional),
			reason: reasonOption,
		},
		(o) =>
			runCommand(ctx, {
				command: "run.interrupt",
				runId: opt(o.runId),
				taskId: opt(o.taskId),
				reason: o.reason,
			}),
	).pipe(
		Command.withDescription("Deliberately interrupt a live run and fail its held task if present."),
	);
	const runTimeout = Command.make(
		"timeout",
		{ runId: runIdOption, reason: reasonOption },
		({ runId, reason }) => runCommand(ctx, { command: "run.timeout", runId, reason }),
	).pipe(Command.withDescription("Mark a non-Pandora no-claim session as timed out."));
	const runParent = Command.make("run").pipe(
		Command.withDescription("Manage durable Pithos run records for agent invocations."),
		Command.withSubcommands([runUpsert, runInspect, runCleanup, runInterrupt, runTimeout]),
	);
	const eventsTail = Command.make(
		"tail",
		{
			limit: Options.integer("limit").pipe(
				Options.withDescription("Maximum number of newest Pithos events to print."),
				Options.optional,
			),
		},
		({ limit }) => runCommand(ctx, { command: "events.tail", limit: opt(limit) }),
	).pipe(Command.withDescription("Print newest durable Pithos events."));
	const events = Command.make("events").pipe(
		Command.withDescription("Inspect durable Pithos event history."),
		Command.withSubcommands([eventsTail]),
	);
	const capability = Options.choice("capability", [
		"triage",
		"design",
		"execute",
		"escalate",
		"intake",
	] as const).pipe(
		Options.withDescription(
			"Task capability used for claim authorization: triage, design, execute, escalate, or intake.",
		),
	);
	const taskEnqueue = Command.make(
		"enqueue",
		{
			scope: Options.text("scope").pipe(
				Options.withDescription("Pithos scope id where the task will be queued."),
			),
			capability,
			title: Options.text("title").pipe(
				Options.withDescription("Short task title shown in graph and inspection output."),
			),
			stdin: stdinFlag,
			runId: runIdOption.pipe(Options.optional),
			dependsOn: Options.text("depends-on").pipe(
				Options.withDescription(
					"Upstream task id that must be done before this task is claimable; repeatable.",
				),
				Options.repeated,
			),
			chain: chainOption,
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
				chain: o.chain,
			}),
	).pipe(
		Command.withDescription(
			"Queue a durable task; --chain auto preserves held-task chains, while source links remain non-blocking provenance.",
		),
	);
	const taskClaim = Command.make(
		"claim",
		{
			runId: runIdOption.pipe(Options.optional),
			scope: Options.text("scope").pipe(Options.withDescription("Pithos scope id to claim from.")),
			capability,
		},
		(o) =>
			runCommand(ctx, {
				command: "task.claim",
				runId: opt(o.runId),
				scope: o.scope,
				capability: o.capability,
			}),
	).pipe(
		Command.withDescription("Claim one claimable task for a run and return its fencing token."),
	);
	const taskHeartbeat = Command.make(
		"heartbeat",
		{
			runId: runIdOption.pipe(Options.optional),
			taskId: taskIdOption.pipe(Options.optional),
			token: Options.integer("token").pipe(
				Options.withDescription("Current fencing token for the held task."),
				Options.optional,
			),
		},
		(o) =>
			runCommand(ctx, {
				command: "task.heartbeat",
				runId: opt(o.runId),
				taskId: opt(o.taskId),
				token: opt(o.token),
			}),
	).pipe(Command.withDescription("Record liveness for a held task claim."));
	const taskComplete = Command.make(
		"complete",
		{
			taskId: Args.text({ name: "task-id" }),
			runId: runIdOption.pipe(Options.optional),
			token: Options.integer("token").pipe(
				Options.withDescription("Current fencing token proving ownership of the held task."),
			),
			stdin: stdinFlag,
		},
		(o) =>
			runCommand(ctx, {
				command: "task.complete",
				taskId: o.taskId,
				runId: opt(o.runId),
				token: o.token,
				stdin: o.stdin,
			}),
	).pipe(Command.withDescription("Complete a held task using its current fencing token."));
	const taskFail = Command.make(
		"fail",
		{
			taskId: Args.text({ name: "task-id" }),
			runId: runIdOption.pipe(Options.optional),
			token: Options.integer("token").pipe(
				Options.withDescription("Current fencing token proving ownership of the held task."),
			),
			reason: reasonOption,
		},
		(o) =>
			runCommand(ctx, {
				command: "task.fail",
				taskId: o.taskId,
				runId: opt(o.runId),
				token: o.token,
				reason: o.reason,
			}),
	).pipe(Command.withDescription("Fail a held task using its current fencing token."));
	const artifactAdd = Command.make(
		"add",
		{
			taskId: Args.text({ name: "task-id" }),
			runId: runIdOption.pipe(Options.optional),
			kind: Options.text("kind").pipe(
				Options.withDescription("Artifact kind, for example note, patch, log, or decision."),
			),
			title: Options.text("title").pipe(
				Options.withDescription("Short artifact title shown with the task."),
			),
			stdin: stdinFlag,
		},
		(o) =>
			runCommand(ctx, {
				command: "task.artifact.add",
				taskId: o.taskId,
				runId: opt(o.runId),
				kind: o.kind,
				title: o.title,
				stdin: o.stdin,
			}),
	).pipe(
		Command.withDescription(
			"Attach an artifact to a task; body is read from stdin when requested.",
		),
	);
	const taskArtifact = Command.make("artifact").pipe(
		Command.withDescription("Attach evidence or output to a Pithos task."),
		Command.withSubcommands([artifactAdd]),
	);
	const taskInspect = Command.make(
		"inspect",
		{
			taskId: Args.text({ name: "task-id" }),
			json: Options.boolean("json").pipe(
				Options.withDescription("Return the full structured inspect object as JSON."),
			),
		},
		(o) => runCommand(ctx, { command: "task.inspect", taskId: o.taskId, json: o.json }),
	).pipe(
		Command.withDescription(
			"Show an agent-readable task handoff; pass --json for structured metadata.",
		),
	);
	const taskCancel = Command.make(
		"cancel",
		{
			taskId: Args.text({ name: "task-id" }),
			runId: runIdOption.pipe(Options.optional),
			reason: reasonOption,
		},
		(o) =>
			runCommand(ctx, {
				command: "task.cancel",
				taskId: o.taskId,
				runId: opt(o.runId),
				reason: o.reason,
			}),
	).pipe(Command.withDescription("Cancel non-held work that should not continue."));
	const taskSupersede = Command.make(
		"supersede",
		{
			taskId: Args.text({ name: "task-id" }),
			runId: runIdOption.pipe(Options.optional),
			reason: reasonOption,
			title: Options.text("title").pipe(
				Options.withDescription("Replacement task title; defaults to the superseded task title."),
				Options.optional,
			),
			stdin: stdinFlag,
			scope: Options.text("scope").pipe(
				Options.withDescription("Replacement task scope; defaults to the superseded task scope."),
				Options.optional,
			),
			capability: capability.pipe(Options.optional),
		},
		(o) =>
			runCommand(ctx, {
				command: "task.supersede",
				taskId: o.taskId,
				runId: opt(o.runId),
				reason: o.reason,
				title: opt(o.title),
				stdin: o.stdin,
				scope: opt(o.scope),
				capability: opt(o.capability),
			}),
	).pipe(
		Command.withDescription(
			"Replace a task with a fresh successor while preserving supersession history.",
		),
	);
	const task = Command.make("task").pipe(
		Command.withDescription("Manage durable Pithos tasks, claims, fencing, and supersession."),
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
			taskId: taskIdOption.pipe(Options.optional),
			scope: Options.text("scope").pipe(
				Options.withDescription("Restrict graph output to one Pithos scope."),
				Options.optional,
			),
			all: Options.boolean("all").pipe(
				Options.withDescription("Include all tasks instead of only active graph roots."),
			),
			hideTerminal: Options.boolean("hide-terminal").pipe(
				Options.withDescription(
					"Omit terminal leaf tasks (done, failed, dead_letter, cancelled) from output; a task-rooted inspect always retains its root.",
				),
			),
			json: Options.boolean("json").pipe(
				Options.withDescription("Return the full structured graph object as JSON."),
			),
		},
		(o) =>
			runCommand(ctx, {
				command: "graph.inspect",
				taskId: opt(o.taskId),
				scope: opt(o.scope),
				all: o.all,
				hideTerminal: o.hideTerminal,
				json: o.json,
			}),
	).pipe(
		Command.withDescription(
			"Render a readable dependency graph; pass --json for structured graph metadata.",
		),
	);
	const graph = Command.make("graph").pipe(
		Command.withDescription(
			"Inspect Pithos task dependency, source-link, and supersession graphs.",
		),
		Command.withSubcommands([graphInspect]),
	);
	const briefing = Command.make(
		"briefing",
		{
			agent: Options.text("agent").pipe(
				Options.withDescription("Agent kind to tailor the briefing for."),
				Options.optional,
			),
			json: Options.boolean("json").pipe(
				Options.withDescription("Return ready and blocked task arrays as JSON."),
			),
		},
		(o) => runCommand(ctx, { command: "briefing", agent: opt(o.agent), json: o.json }),
	).pipe(
		Command.withDescription(
			"Print a readable ready/blocked briefing; pass --json for structured task arrays.",
		),
	);
	return Command.make("pithos").pipe(
		Command.withDescription(
			"Durable state CLI for tasks, runs, claims, artifacts, events, and graph invariants.",
		),
		Command.withSubcommands([init, scope, runParent, task, graph, events, briefing]),
	);
};

export const runPithosCli = (ctx: CliContext, args: readonly string[]) => {
	const command = makePithosCommand(ctx);
	return Effect.gen(function* () {
		const handledHelpJson = yield* handleHelpJson(ctx, args, command);
		if (handledHelpJson) return;
		const cli = Command.run(command, { name: "Pithos", version: "0.1.0", executable: "pithos" });
		yield* cli(args);
	}).pipe(
		Effect.provide(Layer.mergeAll(NodeContext.layer, CliConfig.layer({ showBuiltIns: false }))),
	);
};
