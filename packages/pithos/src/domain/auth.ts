import { Effect, Schema } from "effect"
import type { ScopeRow, RunRow } from "../db/rows.ts"
import { PithosError } from "../errors/errors.ts"
import { DbService } from "../services/db.ts"
import {
  AGENT_KINDS,
  AgentKindSchema,
  CAPABILITIES,
  CapabilitySchema,
  RUN_MODES,
  RunModeSchema,
  type AgentKind,
  type Capability,
  type RunMode,
} from "./control-plane.ts"

export const decodeAgentKind = (rawAgentKind: unknown): Effect.Effect<AgentKind, PithosError> =>
  Schema.decodeUnknown(AgentKindSchema)(rawAgentKind).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `Invalid --agent value: '${String(rawAgentKind)}'. Valid values: ${AGENT_KINDS.join(", ")}`,
        }),
    ),
  )

export const decodeCapability = (rawCapability: unknown): Effect.Effect<Capability, PithosError> =>
  Schema.decodeUnknown(CapabilitySchema)(rawCapability).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `Invalid --capability value: '${String(rawCapability)}'. Valid values: ${CAPABILITIES.join(", ")}`,
        }),
    ),
  )

export const decodeRunMode = (rawMode: unknown): Effect.Effect<RunMode, PithosError> =>
  Schema.decodeUnknown(RunModeSchema)(rawMode).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `Invalid --mode value: '${String(rawMode)}'. Valid values: ${RUN_MODES.join(", ")}`,
        }),
    ),
  )

export const assertCapabilityScopeAllowed = (
  capability: Capability,
  scope: Pick<ScopeRow, "id" | "kind" | "canonical_path">,
): Effect.Effect<void, PithosError> =>
  Effect.gen(function* () {
    switch (capability) {
      case "triage":
      case "design":
        return
      case "escalate": {
        if (scope.kind !== "global") {
          yield* Effect.fail(
            new PithosError({
              code: "VALIDATION_ERROR",
              message: `escalate requires global scope; got ${scope.id} kind=${scope.kind}`,
            }),
          )
        }
        return
      }
      case "execute": {
        if (
          (scope.kind !== "repo" && scope.kind !== "worktree") ||
          scope.canonical_path === null
        ) {
          yield* Effect.fail(
            new PithosError({
              code: "VALIDATION_ERROR",
              message:
                `execute requires scope kind in {repo, worktree} with non-null canonical_path; ` +
                `got ${scope.id} kind=${scope.kind}`,
            }),
          )
        }
        return
      }
    }
  })

const assertRunCapability = (
  run: Pick<RunRow, "id" | "agent_kind">,
  capability: Capability,
  table: "agent_claims" | "agent_enqueues",
  verb: "claim" | "enqueue",
): Effect.Effect<void, PithosError, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const rows = yield* db.query(
      `SELECT agent_kind
       FROM ${table}
       WHERE agent_kind = ?
         AND capability = ?`,
      [run.agent_kind, capability],
    )

    if (rows.length === 0) {
      yield* Effect.fail(
        new PithosError({
          code: "USER_ERROR",
          message: `Agent kind ${run.agent_kind} cannot ${verb} capability ${capability}`,
        }),
      )
    }
  })

export const assertRunCanClaimCapability = (
  run: Pick<RunRow, "id" | "agent_kind">,
  capability: Capability,
): Effect.Effect<void, PithosError, DbService> =>
  assertRunCapability(run, capability, "agent_claims", "claim")

export const assertRunCanEnqueueCapability = (
  run: Pick<RunRow, "id" | "agent_kind">,
  capability: Capability,
): Effect.Effect<void, PithosError, DbService> =>
  assertRunCapability(run, capability, "agent_enqueues", "enqueue")
