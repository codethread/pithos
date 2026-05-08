import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Schema.Class row types — typed DB row decoding at the DB boundary.
// Use these instead of `as SomeType` casts when reading specific fields
// from query results. Failures decode as INTERNAL_ERROR (contract violations,
// not user mistakes).
// ---------------------------------------------------------------------------

export class ScopeRow extends Schema.Class<ScopeRow>("ScopeRow")({
	id: Schema.String,
	kind: Schema.String,
	name: Schema.String,
	canonical_path: Schema.NullOr(Schema.String),
	metadata_json: Schema.String,
	created_at: Schema.String,
	updated_at: Schema.String,
}) {}

export class RunRow extends Schema.Class<RunRow>("RunRow")({
	id: Schema.String,
	agent_kind: Schema.String,
	scope_id: Schema.NullOr(Schema.String),
	task_id: Schema.NullOr(Schema.String),
	parent_run_id: Schema.NullOr(Schema.String),
	harness: Schema.String,
	session_id: Schema.NullOr(Schema.String),
	tmux_target: Schema.NullOr(Schema.String),
	cwd: Schema.NullOr(Schema.String),
	status: Schema.String,
	last_heartbeat_at: Schema.NullOr(Schema.String),
	last_hook: Schema.NullOr(Schema.String),
	last_summary: Schema.NullOr(Schema.String),
	metadata_json: Schema.String,
	created_at: Schema.String,
	updated_at: Schema.String,
	ended_at: Schema.NullOr(Schema.String),
}) {}

export class TaskRow extends Schema.Class<TaskRow>("TaskRow")({
	id: Schema.String,
	scope_id: Schema.String,
	capability: Schema.String,
	status: Schema.String,
	title: Schema.String,
	body: Schema.String,
	payload_json: Schema.String,
	lease_owner_run_id: Schema.NullOr(Schema.String),
	lease_until: Schema.NullOr(Schema.String),
	fencing_token: Schema.Number,
	attempts: Schema.Number,
	max_attempts: Schema.Number,
	result_json: Schema.String,
	created_by_run_id: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	updated_at: Schema.String,
	completed_at: Schema.NullOr(Schema.String),
}) {}

export class ArtifactRow extends Schema.Class<ArtifactRow>("ArtifactRow")({
	id: Schema.String,
	task_id: Schema.NullOr(Schema.String),
	run_id: Schema.NullOr(Schema.String),
	kind: Schema.String,
	title: Schema.String,
	body: Schema.String,
	metadata_json: Schema.String,
	created_at: Schema.String,
}) {}

export class EventRow extends Schema.Class<EventRow>("EventRow")({
	id: Schema.Number,
	created_at: Schema.String,
	actor_run_id: Schema.NullOr(Schema.String),
	task_id: Schema.NullOr(Schema.String),
	run_id: Schema.NullOr(Schema.String),
	type: Schema.String,
	payload_json: Schema.String,
}) {}

export class MigrationRow extends Schema.Class<MigrationRow>("MigrationRow")({
	version: Schema.Number,
}) {}

export class TaskDependencyRow extends Schema.Class<TaskDependencyRow>("TaskDependencyRow")({
	task_id: Schema.String,
	depends_on_task_id: Schema.String,
	created_at: Schema.String,
}) {}

export class TaskSupersessionRow extends Schema.Class<TaskSupersessionRow>("TaskSupersessionRow")({
	old_task_id: Schema.String,
	new_task_id: Schema.String,
	created_by_run_id: Schema.NullOr(Schema.String),
	reason: Schema.String,
	created_at: Schema.String,
}) {}
