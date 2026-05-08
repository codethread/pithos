import { Effect, Schema } from "effect"
import { decodeArtifactRow, decodeMaxIdRow, decodeRunRow, decodeTaskRow } from "../db/helpers.ts"
import {
  loadUnresolvedDependencies,
  type TaskRelationshipSummary,
} from "../domain/task-graph.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"
import type { ArtifactRow, TaskRow } from "../db/rows.ts"

const ValidAgents = ["pandora"] as const
const AgentSchema = Schema.Literal(...ValidAgents)

type BriefingAgent = (typeof ValidAgents)[number]

class HeldTaskRow extends Schema.Class<HeldTaskRow>("HeldTaskRow")({
  run_id: Schema.String,
  task_id: Schema.String,
}) {}

const decodeHeldTaskRow = (row: unknown): Effect.Effect<HeldTaskRow, PithosError> =>
  Schema.decodeUnknown(HeldTaskRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({ code: "INTERNAL_ERROR", message: "held-task row shape violation" }),
    ),
  )

export interface BriefingOptions {
  readonly agent?: string | undefined
}

export const BRIEFING_SQL = {
  TASKS: `SELECT * FROM tasks WHERE status <> 'cancelled' ORDER BY created_at ASC, id ASC`,
  STALE_RUNS: `SELECT *
               FROM runs
               WHERE status IN ('stale', 'timed_out')
                  OR (status IN ('starting', 'running', 'idle')
                      AND ((last_heartbeat_at IS NOT NULL AND datetime(last_heartbeat_at) < datetime('now', '-15 minutes'))
                        OR (last_heartbeat_at IS NULL AND datetime(created_at) < datetime('now', '-15 minutes'))))
               ORDER BY updated_at DESC, id ASC`,
  ARTIFACTS: `SELECT *
              FROM artifacts
              WHERE kind IN ('war-completion', 'design-brief', 'question')
              ORDER BY created_at DESC, id DESC
              LIMIT 50`,
  HELD_TASKS: `SELECT id AS run_id, task_id FROM runs WHERE task_id IS NOT NULL ORDER BY id ASC`,
  WATERMARK: `SELECT MAX(id) AS max_id FROM events`,
} as const

interface QueuedTaskState {
  readonly task: TaskRow
  readonly unresolvedBlockers: readonly TaskRelationshipSummary[]
}

const renderActiveTaskLine = (
  task: TaskRow,
  holderRunId: string | undefined,
  statusLabel: string = task.status,
): string => {
  const holder = holderRunId === undefined ? "" : `, run: ${holderRunId}`
  return `- [${statusLabel}] \`${task.id}\`: "${task.title}" (scope: ${task.scope_id}, capability: ${task.capability}${holder})`
}

const renderBlockerLine = (blocker: TaskRelationshipSummary): string =>
  `  - blocked by \`${blocker.id}\` (scope: ${blocker.scope_id}, status: ${blocker.status})`

export const briefingCommand = (
  opts: BriefingOptions = {},
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const agentRaw = opts.agent ?? "pandora"
    const agent: BriefingAgent = yield* Schema.decodeUnknown(AgentSchema)(agentRaw).pipe(
      Effect.mapError(
        () =>
          new PithosError({
            code: "VALIDATION_ERROR",
            message: `Invalid --agent value: '${agentRaw}'. Valid values: ${ValidAgents.join(", ")}`,
          }),
      ),
    )
    void agent

    const db = yield* DbService
    const output = yield* OutputService

    const { maxEventId, allTasks, queuedTaskStates, staleRuns, artifacts, heldTaskRows } = yield* db.withTransaction(
      Effect.gen(function* () {
        const tasks = yield* db.query(BRIEFING_SQL.TASKS).pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, decodeTaskRow)),
        )

        const queuedTaskStates = yield* Effect.forEach(
          tasks.filter((task) => task.status === "queued"),
          (task) =>
            Effect.provideService(loadUnresolvedDependencies(task.id), DbService, db).pipe(
              Effect.map(
                (unresolvedBlockers): QueuedTaskState => ({
                  task,
                  unresolvedBlockers,
                }),
              ),
            ),
        )

        const staleRuns = yield* db.query(BRIEFING_SQL.STALE_RUNS).pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, decodeRunRow)),
        )
        const artifacts = yield* db.query(BRIEFING_SQL.ARTIFACTS).pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, decodeArtifactRow)),
        )
        const heldTaskRows = yield* db.query(BRIEFING_SQL.HELD_TASKS).pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, decodeHeldTaskRow)),
        )
        const watermarkRows = yield* db.query(BRIEFING_SQL.WATERMARK)
        const watermark = watermarkRows[0] === undefined ? null : yield* decodeMaxIdRow(watermarkRows[0])

        return {
          maxEventId: watermark?.max_id ?? 0,
          allTasks: tasks,
          queuedTaskStates,
          staleRuns,
          artifacts,
          heldTaskRows,
        }
      }),
    )

    const artifactsByTaskId = new Map<string, ArtifactRow[]>()
    for (const artifact of artifacts) {
      const existing = artifactsByTaskId.get(artifact.task_id) ?? []
      existing.push(artifact)
      artifactsByTaskId.set(artifact.task_id, existing)
    }

    const holderByTaskId = new Map<string, string>()
    for (const heldTask of heldTaskRows) {
      holderByTaskId.set(heldTask.task_id, heldTask.run_id)
    }

    const claimedOrRunningTasks = allTasks.filter(
      (task) => task.status === "claimed" || task.status === "running",
    )
    const doneTasks = allTasks.filter((task) => task.status === "done")
    const failedTasks = allTasks.filter((task) => task.status === "failed")
    const deadLetterTasks = allTasks.filter((task) => task.status === "dead_letter")
    const readyQueuedTasks = queuedTaskStates.filter((state) => state.unresolvedBlockers.length === 0)
    const blockedQueuedTasks = queuedTaskStates.filter((state) => state.unresolvedBlockers.length > 0)
    const questionArtifacts = artifacts.filter((artifact) => artifact.kind === "question")

    const lines: string[] = []
    lines.push("## Pandora briefing")
    lines.push("")
    lines.push(`as_of_event_id: ${maxEventId}`)
    lines.push("")

    lines.push("### Needs Adam")
    lines.push("")
    const needsAdamItems: string[] = []
    for (const task of deadLetterTasks) {
      needsAdamItems.push(
        `- [dead_letter] \`${task.id}\`: "${task.title}" (scope: ${task.scope_id}, capability: ${task.capability}, attempts: ${task.attempts}/${task.max_attempts})`,
      )
    }
    for (const artifact of questionArtifacts) {
      needsAdamItems.push(
        `- [question] \`${artifact.task_id}\`: "${artifact.title}" (${artifact.created_at})`,
      )
    }
    lines.push(...(needsAdamItems.length === 0 ? ["_nothing_"] : needsAdamItems))
    lines.push("")

    lines.push("### Ready for review")
    lines.push("")
    const reviewItems: string[] = []
    for (const task of doneTasks) {
      const taskArtifacts = artifactsByTaskId.get(task.id) ?? []
      const reviewArtifacts = taskArtifacts.filter(
        (artifact) => artifact.kind === "war-completion" || artifact.kind === "design-brief",
      )
      const taskLine = `- [done] \`${task.id}\`: "${task.title}" (scope: ${task.scope_id}, capability: ${task.capability})`
      if (reviewArtifacts.length === 0) {
        reviewItems.push(taskLine)
        continue
      }
      reviewItems.push(
        `${taskLine}\n${reviewArtifacts.map((artifact) => `  - ${artifact.kind}: "${artifact.title}" (${artifact.created_at})`).join("\n")}`,
      )
    }
    lines.push(...(reviewItems.length === 0 ? ["_nothing_"] : reviewItems))
    lines.push("")

    lines.push("### Active")
    lines.push("")
    lines.push("#### Ready queued")
    lines.push(
      ...(readyQueuedTasks.length === 0
        ? ["_nothing_"]
        : readyQueuedTasks.map(({ task }) => renderActiveTaskLine(task, holderByTaskId.get(task.id)))),
    )
    lines.push("")

    lines.push("#### Blocked queued")
    if (blockedQueuedTasks.length === 0) {
      lines.push("_nothing_")
    } else {
      for (const blockedTask of blockedQueuedTasks) {
        lines.push(renderActiveTaskLine(blockedTask.task, holderByTaskId.get(blockedTask.task.id), "queued blocked"))
        lines.push(...blockedTask.unresolvedBlockers.map(renderBlockerLine))
      }
    }
    lines.push("")

    lines.push("#### Claimed / running")
    lines.push(
      ...(claimedOrRunningTasks.length === 0
        ? ["_nothing_"]
        : claimedOrRunningTasks.map((task) => renderActiveTaskLine(task, holderByTaskId.get(task.id)))),
    )
    lines.push("")

    lines.push("### Stale / failed")
    lines.push("")
    const staleItems: string[] = []
    for (const run of staleRuns) {
      const heartbeat = run.last_heartbeat_at ?? run.created_at
      staleItems.push(
        `- [${run.status}] \`${run.id}\`: ${run.agent_kind} (${run.mode}, last heartbeat: ${heartbeat})`,
      )
    }
    for (const task of failedTasks) {
      staleItems.push(
        `- [failed] \`${task.id}\`: "${task.title}" (scope: ${task.scope_id}, capability: ${task.capability}, attempts: ${task.attempts}/${task.max_attempts})`,
      )
    }
    lines.push(...(staleItems.length === 0 ? ["_nothing_"] : staleItems))
    lines.push("")

    yield* output.print(lines.join("\n"))
  }).pipe(Effect.withLogSpan("pithos.briefing"), withCommandObservability("briefing"))
