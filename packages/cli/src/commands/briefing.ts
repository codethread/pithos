import { Effect, Schema } from "effect"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { TaskRow, RunRow, ArtifactRow } from "../db/rows.ts"
import {
  loadUnresolvedDependencies,
  type TaskRelationshipSummary,
} from "../domain/task-graph.ts"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const ValidAgents = ["pandora"] as const
type BriefingAgent = (typeof ValidAgents)[number]
const AgentSchema = Schema.Literal(...ValidAgents)

export interface BriefingOptions {
  readonly agent?: string | undefined
}

// ---------------------------------------------------------------------------
// SQL constants — must match the exact strings used in db.query calls below
// so unit-test fake layers can seed rows by SQL key.
// ---------------------------------------------------------------------------

export const BRIEFING_SQL = {
  TASKS: `SELECT * FROM tasks WHERE status NOT IN ('cancelled') ORDER BY created_at ASC, id ASC`,
  /** Stale runs: already marked stale OR active with heartbeat older than 15 minutes. */
  STALE_RUNS: `SELECT * FROM runs WHERE status = 'stale' OR (status IN ('starting', 'running', 'idle') AND ((last_heartbeat_at IS NOT NULL AND datetime(last_heartbeat_at) < datetime('now', '-15 minutes')) OR (last_heartbeat_at IS NULL AND datetime(created_at) < datetime('now', '-15 minutes')))) ORDER BY updated_at DESC`,
  ARTIFACTS: `SELECT * FROM artifacts WHERE kind IN ('worker-completion', 'design-brief', 'question') ORDER BY created_at DESC LIMIT 50`,
  WATERMARK: `SELECT MAX(id) AS max_id FROM events`,
} as const

// ---------------------------------------------------------------------------
// Row decoders (IO boundary)
// ---------------------------------------------------------------------------

const decodeTaskRow = (row: unknown): Effect.Effect<TaskRow, PithosError> =>
  Schema.decodeUnknown(TaskRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "Unexpected task row shape from DB in briefing",
        }),
    ),
  )

const decodeRunRow = (row: unknown): Effect.Effect<RunRow, PithosError> =>
  Schema.decodeUnknown(RunRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "Unexpected run row shape from DB in briefing",
        }),
    ),
  )

const decodeArtifactRow = (row: unknown): Effect.Effect<ArtifactRow, PithosError> =>
  Schema.decodeUnknown(ArtifactRow)(row).pipe(
    Effect.mapError(
      () =>
        new PithosError({
          code: "INTERNAL_ERROR",
          message: "Unexpected artifact row shape from DB in briefing",
        }),
    ),
  )

// ---------------------------------------------------------------------------
// pithos briefing
// ---------------------------------------------------------------------------

/**
 * `pithos briefing [--agent pandora]`
 *
 * Renders a concise markdown briefing with:
 *   - as_of_event_id: <n>  — watermark (latest event ID in the DB at render time)
 *
 * Sections:
 *   ### Needs Adam        dead_letter tasks + question artifacts
 *   ### Ready for review  done tasks, with any worker-completion/design-brief artifact summaries
 *   ### Active            ready queued, blocked queued, then claimed/running tasks
 *   ### Stale / failed    stale runs + failed tasks
 *
 * Output is markdown text (not JSON). The renderer formats facts;
 * Pandora interprets them. No summarisation in code.
 */
interface QueuedTaskState {
  readonly task: TaskRow
  readonly unresolvedBlockers: readonly TaskRelationshipSummary[]
}

const renderActiveTaskLine = (task: TaskRow, statusLabel = task.status): string => {
  const leaseInfo = task.lease_until !== null ? `, lease: ${task.lease_until}` : ""
  const runInfo =
    task.lease_owner_run_id !== null ? `, run: ${task.lease_owner_run_id}` : ""

  return `- [${statusLabel}] \`${task.id}\`: "${task.title}" (scope: ${task.scope_id}, capability: ${task.capability}${runInfo}${leaseInfo})`
}

const renderBlockerLine = (blocker: TaskRelationshipSummary): string =>
  `  - blocked by \`${blocker.id}\` (scope: ${blocker.scope_id}, status: ${blocker.status})`

export const briefingCommand = (
  opts: BriefingOptions = {},
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    // Validate --agent.
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
    void agent // selects briefing style; pandora is the only style for MVP

    const db = yield* DbService
    const output = yield* OutputService

    // All reads happen inside one transaction so the watermark and the
    // rendered rows share a consistent SQLite snapshot. Watermark is read
    // last: it captures the max event ID as of the moment all task/run/
    // artifact rows were fetched, preserving the incremental-sync contract.
    const { maxEventId, allTasks, queuedTaskStates, staleRuns, artifacts } = yield* db.withTransaction(
      Effect.gen(function* () {
        // All non-cancelled tasks.
        const rawTaskRows = yield* db.query(BRIEFING_SQL.TASKS, [])
        const tasks = yield* Effect.forEach(rawTaskRows, decodeTaskRow)

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

        // Stale/expired runs: already marked stale OR active with old heartbeat.
        const rawRunRows = yield* db.query(BRIEFING_SQL.STALE_RUNS, [])
        const runs = yield* Effect.forEach(rawRunRows, decodeRunRow)

        // Recent relevant artifacts.
        const rawArtifactRows = yield* db.query(BRIEFING_SQL.ARTIFACTS, [])
        const arts = yield* Effect.forEach(rawArtifactRows, decodeArtifactRow)

        // Watermark last: max event ID consistent with the rows just read.
        const watermarkRows = yield* db.query(BRIEFING_SQL.WATERMARK, [])
        const firstRow = watermarkRows[0]
        const rawMaxId = firstRow !== undefined ? firstRow.max_id : null
        const maxId: number | null = typeof rawMaxId === "number" ? rawMaxId : null

        return {
          maxEventId: maxId,
          allTasks: tasks,
          queuedTaskStates,
          staleRuns: runs,
          artifacts: arts,
        }
      }),
    )

    // Index artifacts by task_id for O(1) lookup.
    const artifactsByTaskId = new Map<string, ArtifactRow[]>()
    for (const artifact of artifacts) {
      if (artifact.task_id !== null) {
        const existing = artifactsByTaskId.get(artifact.task_id) ?? []
        existing.push(artifact)
        artifactsByTaskId.set(artifact.task_id, existing)
      }
    }

    // Categorise tasks by status.
    const queuedTasks = queuedTaskStates.map((taskState) => taskState.task)
    const claimedOrRunningTasks = allTasks.filter(
      (t) => t.status === "claimed" || t.status === "running",
    )
    const doneTasks = allTasks.filter((t) => t.status === "done")
    const failedTasks = allTasks.filter((t) => t.status === "failed")
    const deadLetterTasks = allTasks.filter((t) => t.status === "dead_letter")
    const readyQueuedTasks = queuedTaskStates.filter(
      (taskState) => taskState.unresolvedBlockers.length === 0,
    )
    const blockedQueuedTasks = queuedTaskStates.filter(
      (taskState) => taskState.unresolvedBlockers.length > 0,
    )

    // Question artifacts go in Needs Adam.
    const questionArtifacts = artifacts.filter((a) => a.kind === "question")

    // Build markdown.
    const lines: string[] = []

    lines.push(`## Pandora briefing`)
    lines.push(``)
    lines.push(`as_of_event_id: ${maxEventId ?? 0}`)
    lines.push(``)

    // --- Needs Adam ---
    lines.push(`### Needs Adam`)
    lines.push(``)
    const needsAdamItems: string[] = []
    for (const task of deadLetterTasks) {
      needsAdamItems.push(
        `- [dead_letter] \`${task.id}\`: "${task.title}" (scope: ${task.scope_id}, capability: ${task.capability}, attempts: ${task.attempts}/${task.max_attempts})`,
      )
    }
    for (const artifact of questionArtifacts) {
      needsAdamItems.push(
        `- [question] \`${artifact.task_id ?? "no-task"}\`: "${artifact.title}" (${artifact.created_at})`,
      )
    }
    if (needsAdamItems.length === 0) {
      lines.push(`_nothing_`)
    } else {
      lines.push(...needsAdamItems)
    }
    lines.push(``)

    // --- Ready for review ---
    lines.push(`### Ready for review`)
    lines.push(``)
    const readyItems: string[] = []
    for (const task of doneTasks) {
      const taskArtifacts = artifactsByTaskId.get(task.id) ?? []
      const reviewArtifacts = taskArtifacts.filter(
        (a) => a.kind === "worker-completion" || a.kind === "design-brief",
      )
      const taskLine = `- [done] \`${task.id}\`: "${task.title}" (scope: ${task.scope_id}, capability: ${task.capability})`
      if (reviewArtifacts.length > 0) {
        const artifactLines = reviewArtifacts
          .map((a) => `  - ${a.kind}: "${a.title}" (${a.created_at})`)
          .join("\n")
        readyItems.push(`${taskLine}\n${artifactLines}`)
      } else {
        readyItems.push(taskLine)
      }
    }
    if (readyItems.length === 0) {
      lines.push(`_nothing_`)
    } else {
      lines.push(...readyItems)
    }
    lines.push(``)

    // --- Active ---
    lines.push(`### Active`)
    lines.push(``)

    lines.push(`#### Ready queued`)
    if (readyQueuedTasks.length === 0) {
      lines.push(`_nothing_`)
    } else {
      lines.push(...readyQueuedTasks.map(({ task }) => renderActiveTaskLine(task)))
    }
    lines.push(``)

    lines.push(`#### Blocked queued`)
    if (blockedQueuedTasks.length === 0) {
      lines.push(`_nothing_`)
    } else {
      for (const blockedTask of blockedQueuedTasks) {
        lines.push(renderActiveTaskLine(blockedTask.task, "queued blocked"))
        lines.push(...blockedTask.unresolvedBlockers.map(renderBlockerLine))
      }
    }
    lines.push(``)

    lines.push(`#### Claimed / running`)
    if (claimedOrRunningTasks.length === 0) {
      lines.push(`_nothing_`)
    } else {
      lines.push(...claimedOrRunningTasks.map((task) => renderActiveTaskLine(task)))
    }
    lines.push(``)

    // --- Stale / failed ---
    lines.push(`### Stale / failed`)
    lines.push(``)
    const staleItems: string[] = []
    for (const run of staleRuns) {
      const heartbeat = run.last_heartbeat_at ?? run.created_at
      staleItems.push(
        `- [stale run] \`${run.id}\`: ${run.agent_kind} (last heartbeat: ${heartbeat})`,
      )
    }
    for (const task of failedTasks) {
      staleItems.push(
        `- [failed] \`${task.id}\`: "${task.title}" (scope: ${task.scope_id}, capability: ${task.capability}, attempts: ${task.attempts}/${task.max_attempts})`,
      )
    }
    if (staleItems.length === 0) {
      lines.push(`_nothing_`)
    } else {
      lines.push(...staleItems)
    }
    lines.push(``)

    yield* Effect.logDebug("briefing rendered").pipe(
      Effect.annotateLogs({
        agent: agentRaw,
        as_of_event_id: String(maxEventId ?? 0),
        active: String(queuedTasks.length + claimedOrRunningTasks.length),
        ready_queued: String(readyQueuedTasks.length),
        blocked_queued: String(blockedQueuedTasks.length),
        done: String(doneTasks.length),
        failed: String(failedTasks.length),
        dead_letter: String(deadLetterTasks.length),
        stale_runs: String(staleRuns.length),
      }),
    )

    yield* output.print(lines.join("\n"))
  }).pipe(
    Effect.withLogSpan("pithos.briefing"),
    withCommandObservability("briefing"),
  )

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const BRIEFING_HELP = `pithos briefing - Render a concise Pandora briefing

Usage:
  pithos briefing [options]

Options:
  --agent <name>   Agent perspective for the briefing (default: pandora; only pandora is supported)
  --help, -h       Show this help

Output (markdown):
  ## Pandora briefing

  as_of_event_id: <n>

  ### Needs Adam
  - dead_letter tasks and question artifacts requiring human attention

  ### Ready for review
  - done tasks with their worker-completion and design-brief artifact summaries

  ### Active
  #### Ready queued
  - queued tasks whose direct blockers are all done

  #### Blocked queued
  - queued tasks with direct unresolved blockers, each listing blocker task id, scope, and status

  #### Claimed / running
  - currently leased work

  ### Stale / failed
  - runs marked stale or with heartbeat older than 15 minutes, plus failed tasks

Notes:
  - as_of_event_id is the latest event ID at render time; use it as a briefing watermark.
  - All DB reads run inside a single transaction so the watermark and rows are consistent.
  - Cancelled tasks are excluded.
  - Ready queued tasks appear before blocked queued tasks, which appear before claimed/running tasks.
  - Blocked queued tasks list all direct unresolved blockers ordered by blocker created_at, then blocker id.
  - Stale run detection uses the same 15-minute heartbeat threshold as pithos sweep.
  - The renderer formats raw facts; Pandora interprets them. No summarisation in code.

Examples:
  pithos briefing
  pithos briefing --agent pandora

Exit codes: 0 success | 2 validation error
`
