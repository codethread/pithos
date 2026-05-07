import { Schema } from "effect"
import {
  AgentKindSchema,
  CapabilitySchema,
  RunModeSchema,
  RunStatusSchema,
  TaskStatusSchema,
} from "../domain/control-plane.ts"
import { ScopeKindSchema } from "../domain/scope.ts"

export class ScopeRow extends Schema.Class<ScopeRow>("ScopeRow")({
  id: Schema.String,
  kind: ScopeKindSchema,
  name: Schema.String,
  canonical_path: Schema.NullOr(Schema.String),
  metadata_json: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

export class RunRow extends Schema.Class<RunRow>("RunRow")({
  id: Schema.String,
  agent_kind: AgentKindSchema,
  mode: RunModeSchema,
  scope_id: Schema.String,
  task_id: Schema.NullOr(Schema.String),
  harness: Schema.String,
  session_id: Schema.String,
  tmux_target: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  status: RunStatusSchema,
  last_heartbeat_at: Schema.NullOr(Schema.String),
  metadata_json: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  ended_at: Schema.NullOr(Schema.String),
}) {}

export class TaskRow extends Schema.Class<TaskRow>("TaskRow")({
  id: Schema.String,
  scope_id: Schema.String,
  capability: CapabilitySchema,
  status: TaskStatusSchema,
  title: Schema.String,
  body: Schema.String,
  payload_json: Schema.String,
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
  task_id: Schema.String,
  run_id: Schema.String,
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

export class TaskSupersessionRow extends Schema.Class<TaskSupersessionRow>(
  "TaskSupersessionRow",
)({
  old_task_id: Schema.String,
  new_task_id: Schema.String,
  created_by_run_id: Schema.NullOr(Schema.String),
  reason: Schema.String,
  created_at: Schema.String,
}) {}

export class AgentKindRow extends Schema.Class<AgentKindRow>("AgentKindRow")({
  agent_kind: AgentKindSchema,
  created_at: Schema.String,
}) {}

export class CapabilityRow extends Schema.Class<CapabilityRow>("CapabilityRow")({
  capability: CapabilitySchema,
  created_at: Schema.String,
}) {}

export class AgentClaimRow extends Schema.Class<AgentClaimRow>("AgentClaimRow")({
  agent_kind: AgentKindSchema,
  capability: CapabilitySchema,
  created_at: Schema.String,
}) {}

export class AgentEnqueueRow extends Schema.Class<AgentEnqueueRow>("AgentEnqueueRow")({
  agent_kind: AgentKindSchema,
  capability: CapabilitySchema,
  created_at: Schema.String,
}) {}
