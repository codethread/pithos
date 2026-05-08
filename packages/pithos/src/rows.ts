import { Either, Schema } from "effect";
import { fail } from "./errors.js";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const NullableString = Schema.NullOr(Schema.String);

export const RunRowSchema = Schema.Struct({
	id: NonEmptyString,
	agent_kind: Schema.Literal("pdx", "pandora", "toil", "greed", "war"),
	mode: Schema.Literal("afk", "hitl"),
	scope_id: NonEmptyString,
	cwd: Schema.optional(Schema.String),
	status: Schema.Literal("live", "ended", "failed", "cancelled", "timed_out"),
	task_id: NullableString,
	session_id: NonEmptyString,
	created_at: NonEmptyString,
	updated_at: NonEmptyString,
});

export const TaskRowSchema = Schema.Struct({
	id: NonEmptyString,
	scope_id: NonEmptyString,
	capability: Schema.Literal("triage", "design", "execute", "escalate"),
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
});

export type RunRow = typeof RunRowSchema.Type;
export type TaskRow = typeof TaskRowSchema.Type;
export type ScopeRow = typeof ScopeRowSchema.Type;

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
