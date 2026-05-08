import { Command, HelpDoc, Options } from "@effect/cli";
import { Option, Schema } from "effect";
import type { Effect } from "effect";
import type { SpawnerError } from "./errors.ts";
import type { HarnessService } from "./harness.ts";
import { HarnessNameSchema, HarnessNameValues } from "./harness-name.ts";

export const SpawnCliInputSchema = Schema.Struct({
	agent: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
	scope: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
	task: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
	message: Schema.optionalWith(Schema.String, { exact: true }),
	cwd: Schema.NonEmptyString,
	harness: Schema.optionalWith(HarnessNameSchema, { exact: true }),
	preview: Schema.Boolean,
});
export type SpawnCliInput = Schema.Schema.Type<typeof SpawnCliInputSchema>;

export const SpawnInvocationSchema = Schema.Struct({
	agent: Schema.NonEmptyString,
	scope: Schema.NonEmptyString,
	task: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
	message: Schema.optionalWith(Schema.String, { exact: true }),
	cwd: Schema.NonEmptyString,
	harness: Schema.optionalWith(HarnessNameSchema, { exact: true }),
	preview: Schema.Boolean,
});
export type SpawnInvocation = Schema.Schema.Type<typeof SpawnInvocationSchema>;

export const StatusCliInputSchema = Schema.Struct({
	sessionId: Schema.NonEmptyString,
	lines: Schema.Int.pipe(Schema.positive()),
});
export type StatusCliInput = Schema.Schema.Type<typeof StatusCliInputSchema>;

export const NudgeCliInputSchema = Schema.Struct({
	target: Schema.NonEmptyString,
	message: Schema.NonEmptyString,
});
export type NudgeCliInput = Schema.Schema.Type<typeof NudgeCliInputSchema>;

export const TargetCliInputSchema = Schema.Struct({
	target: Schema.NonEmptyString,
});
export type TargetCliInput = Schema.Schema.Type<typeof TargetCliInputSchema>;

export interface CliHandlers {
	readonly spawn: (input: SpawnCliInput) => Effect.Effect<void, SpawnerError, HarnessService>;
	readonly status: (input: StatusCliInput) => Effect.Effect<void, SpawnerError, HarnessService>;
	readonly nudge: (input: NudgeCliInput) => Effect.Effect<void, SpawnerError, never>;
	readonly kill: (input: TargetCliInput) => Effect.Effect<void, SpawnerError, never>;
	readonly ttyStatus: (input: TargetCliInput) => Effect.Effect<void, SpawnerError, never>;
	readonly templatesList: () => Effect.Effect<void, SpawnerError, never>;
}

const opt = <A>(o: Option.Option<A>): A | undefined => Option.getOrUndefined(o);

const desc = (
	summary: string,
	cmdPath: string,
	examples: readonly string[],
	exitCodesLine: string,
): HelpDoc.HelpDoc =>
	HelpDoc.blocks([
		HelpDoc.p(`${cmdPath} - ${summary}`),
		HelpDoc.p("Examples:"),
		...examples.map((example) => HelpDoc.p(`  ${example}`)),
		HelpDoc.p(`Exit codes: ${exitCodesLine}`),
	]);

export const makePandoraSpawnCommand = (handlers: CliHandlers) => {
	const status = Command.make(
		"status",
		{
			sessionId: Options.text("session-id").pipe(
				Options.withSchema(Schema.NonEmptyString),
				Options.withDescription("Harness session id to inspect"),
			),
			lines: Options.integer("lines").pipe(
				Options.withSchema(Schema.Int.pipe(Schema.positive())),
				Options.withDefault(10),
				Options.withDescription("Recent message count to render (default: 10)"),
			),
		},
		({ sessionId, lines }) => handlers.status({ sessionId, lines }),
	).pipe(
		Command.withDescription(
			desc(
				"Render recent harness session messages",
				"pandora-spawn status",
				["pandora-spawn status --session-id session_abc --lines 20"],
				"0 success | 2 validation error | 3 session not found",
			),
		),
	);

	const nudge = Command.make(
		"nudge",
		{
			target: Options.text("target").pipe(
				Options.withSchema(Schema.NonEmptyString),
				Options.withDescription("tmux target/session name"),
			),
			message: Options.text("message").pipe(
				Options.withSchema(Schema.NonEmptyString),
				Options.withDescription("Message to send followed by Enter"),
			),
		},
		({ target, message }) => handlers.nudge({ target, message }),
	).pipe(
		Command.withDescription(
			desc(
				"Send a nudge into a tmux-backed harness session",
				"pandora-spawn nudge",
				["pandora-spawn nudge --target pithos-envy-12345678 --message 'status?'"],
				"0 success | 2 validation error | 1 tmux error",
			),
		),
	);

	const kill = Command.make(
		"kill",
		{
			target: Options.text("target").pipe(
				Options.withSchema(Schema.NonEmptyString),
				Options.withDescription("tmux target/session name"),
			),
		},
		({ target }) => handlers.kill({ target }),
	).pipe(
		Command.withDescription(
			desc(
				"Kill a tmux-backed harness session",
				"pandora-spawn kill",
				["pandora-spawn kill --target pithos-envy-12345678"],
				"0 success | 2 validation error | 1 tmux error",
			),
		),
	);

	const ttyStatus = Command.make(
		"tty-status",
		{
			target: Options.text("target").pipe(
				Options.withSchema(Schema.NonEmptyString),
				Options.withDescription("tmux target/session name"),
			),
		},
		({ target }) => handlers.ttyStatus({ target }),
	).pipe(
		Command.withDescription(
			desc(
				"Capture the current tmux pane contents",
				"pandora-spawn tty-status",
				["pandora-spawn tty-status --target pithos-envy-12345678"],
				"0 success | 2 validation error | 1 tmux error",
			),
		),
	);

	const templatesList = Command.make("list", {}, () => handlers.templatesList()).pipe(
		Command.withDescription(
			desc(
				"List available agent templates",
				"pandora-spawn templates list",
				["pandora-spawn templates list"],
				"0 success | 2 template/config error",
			),
		),
	);

	const templates = Command.make("templates").pipe(
		Command.withDescription("Inspect agent templates"),
		Command.withSubcommands([templatesList]),
	);

	return Command.make(
		"pandora-spawn",
		{
			agent: Options.text("agent").pipe(
				Options.optional,
				Options.withDescription("Agent name to spawn, e.g. envy or pandora"),
			),
			scope: Options.text("scope").pipe(
				Options.optional,
				Options.withDescription("Pithos scope id for the session"),
			),
			task: Options.text("task").pipe(
				Options.optional,
				Options.withDescription("Optional task id to attach to the session"),
			),
			message: Options.text("message").pipe(
				Options.optional,
				Options.withDescription("Optional kickoff message override"),
			),
			cwd: Options.text("cwd").pipe(
				Options.withSchema(Schema.NonEmptyString),
				Options.withDefault(process.cwd()),
				Options.withDescription("Working directory when the agent has no template cwd override"),
			),
			harness: Options.choice("harness", HarnessNameValues).pipe(
				Options.optional,
				Options.withDescription(
					"Harness adapter override: claude, pi, or fake. Defaults to the template harness.",
				),
			),
			preview: Options.boolean("preview").pipe(
				Options.withDescription("Render only; do not register a run or launch a harness"),
			),
		},
		({ agent, scope, task, message, cwd, harness, preview }) => {
			const agentValue = opt(agent);
			const scopeValue = opt(scope);
			const taskValue = opt(task);
			const messageValue = opt(message);
			const harnessValue = opt(harness);
			return handlers.spawn({
				...(agentValue !== undefined ? { agent: agentValue } : {}),
				...(scopeValue !== undefined ? { scope: scopeValue } : {}),
				...(taskValue !== undefined ? { task: taskValue } : {}),
				...(messageValue !== undefined ? { message: messageValue } : {}),
				cwd,
				...(harnessValue !== undefined ? { harness: harnessValue } : {}),
				preview,
			});
		},
	).pipe(
		Command.withDescription(
			HelpDoc.blocks([
				HelpDoc.p("Spawn agent sessions from versioned templates. Default command is spawn."),
				HelpDoc.p("Environment:"),
				HelpDoc.p("  PANDORA_SPAWN_FAKE_PITHOS_HELP  Override captured `pithos --help` text"),
				HelpDoc.p("  PANDORA_SPAWN_FAKE_RUN_ID       Force run_id (preview/tests)"),
				HelpDoc.p("  PANDORA_SPAWN_FAKE_SESSION_ID   Force session_id (preview/tests)"),
				HelpDoc.p("Exit codes:"),
				HelpDoc.p("  0  Success"),
				HelpDoc.p("  1  Upstream / subprocess error"),
				HelpDoc.p("  2  Validation / template error"),
				HelpDoc.p("  3  Not found"),
				HelpDoc.p("Examples:"),
				HelpDoc.p("  pandora-spawn --agent envy --scope repo:work/example --preview"),
				HelpDoc.p("  pandora-spawn --agent envy --scope repo:work/example --harness fake"),
				HelpDoc.p("  pandora-spawn templates list"),
			]),
		),
		Command.withSubcommands([status, nudge, kill, ttyStatus, templates]),
	);
};
