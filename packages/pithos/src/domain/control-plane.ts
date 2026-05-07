import { Schema } from "effect"

export const AGENT_KINDS = ["pdx", "pandora", "toil", "greed", "war"] as const
export const CAPABILITIES = ["triage", "design", "execute", "escalate"] as const
export const RUN_MODES = ["afk", "hitl"] as const
export const RUN_STATUSES = [
  "starting",
  "running",
  "idle",
  "stale",
  "ended",
  "failed",
  "cancelled",
  "timed_out",
] as const
export const TASK_STATUSES = [
  "queued",
  "claimed",
  "running",
  "done",
  "failed",
  "dead_letter",
  "cancelled",
] as const

export const AgentKindSchema = Schema.Literal(...AGENT_KINDS)
export type AgentKind = typeof AgentKindSchema.Type

export const CapabilitySchema = Schema.Literal(...CAPABILITIES)
export type Capability = typeof CapabilitySchema.Type

export const RunModeSchema = Schema.Literal(...RUN_MODES)
export type RunMode = typeof RunModeSchema.Type

export const RunStatusSchema = Schema.Literal(...RUN_STATUSES)
export type RunStatus = typeof RunStatusSchema.Type

export const TaskStatusSchema = Schema.Literal(...TASK_STATUSES)
export type TaskStatus = typeof TaskStatusSchema.Type
