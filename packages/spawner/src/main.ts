import { CliConfig, Command, Options } from "@effect/cli";
import * as ValidationError from "@effect/cli/ValidationError";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Option, ParseResult, Schema } from "effect";
import { SpawnerError, exitCodeFor, type ErrorCode } from "./errors.js";
import { AgentKindSchema, ModeSchema, renderAgent } from "./spawner.js";

const PreviewInputSchema = Schema.Struct({
	agent: AgentKindSchema,
	mode: ModeSchema,
	runId: Schema.NonEmptyString,
	sessionId: Schema.NonEmptyString,
	scopeId: Schema.NonEmptyString,
	cwd: Schema.NonEmptyString,
	parentRepoPath: Schema.optional(Schema.NonEmptyString),
});

type PreviewInput = Schema.Schema.Type<typeof PreviewInputSchema>;

const opt = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value);

const writeJson = (value: unknown): void => {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const writeError = (code: ErrorCode, message: string): void => {
	process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
};

const decode = <A, I>(
	schema: Schema.Schema<A, I>,
	value: unknown,
): Effect.Effect<A, SpawnerError> =>
	Schema.decodeUnknown(schema)(value).pipe(
		Effect.mapError(
			(error) =>
				new SpawnerError({
					code: "VALIDATION_ERROR",
					message: `invalid preview invocation\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
				}),
		),
	);

const preview = (raw: PreviewInput) =>
	Effect.gen(function* () {
		const input = yield* decode(PreviewInputSchema, raw);
		writeJson(
			renderAgent({
				agent: input.agent,
				mode: input.mode,
				runId: input.runId,
				sessionId: input.sessionId,
				scopeId: input.scopeId,
				cwd: input.cwd,
				...(input.parentRepoPath === undefined ? {} : { parentRepoPath: input.parentRepoPath }),
			}),
		);
	});

const previewCommand = Command.make(
	"preview",
	{
		agent: Options.text("agent").pipe(
			Options.withSchema(AgentKindSchema),
			Options.withDescription("Agent kind: pandora, toil, greed, or war"),
		),
		mode: Options.choice("mode", ["afk", "hitl"] as const).pipe(
			Options.withDescription("Launch mode; must match manifest"),
		),
		scopeId: Options.text("scope").pipe(
			Options.withSchema(Schema.NonEmptyString),
			Options.withDescription("Pithos scope id"),
		),
		runId: Options.text("run").pipe(
			Options.withSchema(Schema.NonEmptyString),
			Options.withDescription("Caller-supplied Pithos run id"),
		),
		sessionId: Options.text("session-id").pipe(
			Options.withSchema(Schema.NonEmptyString),
			Options.withDescription("Caller-supplied harness session id"),
		),
		cwd: Options.text("cwd").pipe(
			Options.withSchema(Schema.NonEmptyString),
			Options.withDescription("Working directory for the harness"),
		),
		parentRepoPath: Options.optional(Options.text("parent-repo")).pipe(
			Options.withDescription("Durable parent repo root for worktree scope previews"),
		),
	},
	({ agent, mode, scopeId, runId, sessionId, cwd, parentRepoPath }) =>
		preview({
			agent,
			mode,
			scopeId,
			runId,
			sessionId,
			cwd,
			...(opt(parentRepoPath) === undefined ? {} : { parentRepoPath: opt(parentRepoPath) }),
		}),
).pipe(
	Command.withDescription(
		"Render an agent prompt and harness launch description without touching Pithos state.",
	),
);

const command = Command.make("pandora-spawn").pipe(
	Command.withDescription(
		"Harness prompt renderer for Pandora's Box agent runs. Launch, kill, and supervision are owned by pdx.",
	),
	Command.withSubcommands([previewCommand]),
);

const cli = Command.run(command, {
	name: "Pandora's Box Spawner",
	version: "0.1.0",
	executable: "pandora-spawn",
});

const program = cli(process.argv).pipe(
	Effect.catchTag("SpawnerError", (error) =>
		Effect.sync(() => {
			writeError(error.code, error.message);
			process.exit(exitCodeFor(error.code));
		}),
	),
	Effect.catchAll((error: unknown) =>
		ValidationError.isValidationError(error)
			? Effect.sync(() => process.exit(2))
			: Effect.sync(() => {
					const message = error instanceof Error ? error.message : String(error);
					writeError("LAUNCH_ERROR", message);
					process.exit(1);
				}),
	),
	Effect.provide(Layer.mergeAll(NodeContext.layer, CliConfig.layer({ showBuiltIns: true }))),
);

NodeRuntime.runMain(program);
