import { Either, Schema } from "effect";
import { fail } from "./errors.js";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const NullableString = Schema.NullOr(Schema.String);

export const RunRowSchema = Schema.Struct({
	id: NonEmptyString,
	agent_kind: NonEmptyString,
	mode: Schema.Literal("afk", "hitl"),
	scope_id: NonEmptyString,
	cwd: Schema.optional(Schema.String),
	harness_kind: Schema.Literal("claude", "pi", "system"),
	session_log_path: NonEmptyString,
	status: Schema.Literal("live", "ended", "failed", "cancelled", "timed_out"),
	task_id: NullableString,
	session_id: NonEmptyString,
	created_at: NonEmptyString,
	updated_at: NonEmptyString,
});

export const TaskRowSchema = Schema.Struct({
	id: NonEmptyString,
	scope_id: NonEmptyString,
	capability: Schema.Literal("triage", "design", "execute", "escalate", "intake"),
	title: Schema.String,
	body: Schema.String,
	status: Schema.Literal(
		"queued",
		"claimed",
		"running",
		"done",
		"failed",
		"dead_letter",
		"cancelled",
	),
	fencing_token: Schema.Number,
	attempts: Schema.Number,
	max_attempts: Schema.Number,
	created_at: NonEmptyString,
});

export const ScopeRowSchema = Schema.Struct({
	id: NonEmptyString,
	kind: Schema.Literal("global", "repo", "worktree"),
	canonical_path: NullableString,
	archived_at: NullableString,
	description: NullableString,
});

export const EventRowSchema = Schema.Struct({
	id: NonEmptyString,
	type: NonEmptyString,
	task_id: NullableString,
	run_id: NullableString,
	actor_run_id: NullableString,
	payload_json: Schema.String,
	created_at: NonEmptyString,
});

export const RepairAlertKindSchema = Schema.Literal(
	"interrupt",
	"task_failed",
	"dead_letter",
	"launch_precondition",
	"reconciler_stuck",
	"kill_failure",
	"input_hook_stuck",
	"hook_config_error",
);
export type RepairAlertKind = typeof RepairAlertKindSchema.Type;

export type RunRow = typeof RunRowSchema.Type;
export type TaskRow = typeof TaskRowSchema.Type;
export type ScopeRow = typeof ScopeRowSchema.Type;
export type EventRow = typeof EventRowSchema.Type;

export const decodeRow = <A, I>(
	schema: Schema.Schema<A, I>,
	value: unknown,
	message: string,
): A => {
	if (value === undefined) fail("NOT_FOUND", message);
	const result = Schema.decodeUnknownEither(schema)(value);
	return Either.match(result, {
		onLeft: () => fail("INTERNAL_ERROR", `malformed database row: ${message}`),
		onRight: (row) => row,
	});
};
