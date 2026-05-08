import { Schema } from "effect"

export const AGENT_KINDS = ["pdx", "pandora", "toil", "greed", "war"] as const
export const SPAWNABLE_AGENT_KINDS = ["pandora", "toil", "greed", "war"] as const
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

export const SpawnableAgentKindSchema = Schema.Literal(...SPAWNABLE_AGENT_KINDS)
export type SpawnableAgentKind = typeof SpawnableAgentKindSchema.Type

export const CapabilitySchema = Schema.Literal(...CAPABILITIES)
export type Capability = typeof CapabilitySchema.Type

export const AGENT_CLAIMS_BY_KIND = {
  pdx: [],
  pandora: ["escalate"],
  toil: ["triage"],
  greed: ["design"],
  war: ["execute"],
} as const satisfies Readonly<Record<AgentKind, readonly Capability[]>>

export const AGENT_ENQUEUES_BY_KIND = {
  pdx: ["escalate"],
  pandora: ["triage", "design", "escalate"],
  toil: ["triage", "design", "execute", "escalate"],
  greed: ["triage", "design", "escalate"],
  war: ["escalate"],
} as const satisfies Readonly<Record<AgentKind, readonly Capability[]>>

export const RunModeSchema = Schema.Literal(...RUN_MODES)
export type RunMode = typeof RunModeSchema.Type

export const RunStatusSchema = Schema.Literal(...RUN_STATUSES)
export type RunStatus = typeof RunStatusSchema.Type

export const TaskStatusSchema = Schema.Literal(...TASK_STATUSES)
export type TaskStatus = typeof TaskStatusSchema.Type
