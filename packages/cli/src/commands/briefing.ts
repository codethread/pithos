import { Effect, Schema } from "effect"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { TaskRow, RunRow, ArtifactRow } from "../db/rows.ts"

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
  WATERMARK: `SELECT MAX(id) AS max_id FROM events`,
  TASKS: `SELECT * FROM tasks WHERE status NOT IN ('cancelled') ORDER BY created_at ASC`,
  STALE_RUNS: `SELECT * FROM runs WHERE status = 'stale' ORDER BY updated_at DESC`,
  ARTIFACTS: `SELECT * FROM artifacts WHERE kind IN ('worker-completion', 'design-brief', 'question') ORDER BY created_at DESC LIMIT 50`,
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
 *   ### Needs Adam      dead_letter tasks + question artifacts
 *   ### Ready for review  done tasks, with any worker-completion/design-brief artifact summaries
 *   ### Active          queued + claimed + running tasks
 *   ### Stale / failed  stale runs + failed tasks
 *
 * Output is markdown text (not JSON). The renderer formats facts;
 * Pandora interprets them. No summarisation in code.
 */
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

    // Watermark: the max event ID at the time the briefing is generated.
    const watermarkRows = yield* db.query(BRIEFING_SQL.WATERMARK, [])
    const firstRow = watermarkRows[0]
    const rawMaxId = firstRow !== undefined ? firstRow.max_id : null
    const maxEventId: number | null = typeof rawMaxId === "number" ? rawMaxId : null

    // All non-cancelled tasks.
    const rawTaskRows = yield* db.query(BRIEFING_SQL.TASKS, [])
    const allTasks = yield* Effect.forEach(rawTaskRows, decodeTaskRow)

    // Stale runs.
    const rawRunRows = yield* db.query(BRIEFING_SQL.STALE_RUNS, [])
    const staleRuns = yield* Effect.forEach(rawRunRows, decodeRunRow)

    // Recent relevant artifacts.
    const rawArtifactRows = yield* db.query(BRIEFING_SQL.ARTIFACTS, [])
    const artifacts = yield* Effect.forEach(rawArtifactRows, decodeArtifactRow)

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
    const queuedTasks = allTasks.filter((t) => t.status === "queued")
    const activeTasks = allTasks.filter((t) => t.status === "claimed" || t.status === "running")
    const doneTasks = allTasks.filter((t) => t.status === "done")
    const failedTasks = allTasks.filter((t) => t.status === "failed")
    const deadLetterTasks = allTasks.filter((t) => t.status === "dead_letter")

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
    const activeItems: string[] = []
    for (const task of [...queuedTasks, ...activeTasks]) {
      const leaseInfo = task.lease_until !== null ? `, lease: ${task.lease_until}` : ""
      const runInfo =
        task.lease_owner_run_id !== null ? `, run: ${task.lease_owner_run_id}` : ""
      activeItems.push(
        `- [${task.status}] \`${task.id}\`: "${task.title}" (scope: ${task.scope_id}, capability: ${task.capability}${runInfo}${leaseInfo})`,
      )
    }
    if (activeItems.length === 0) {
      lines.push(`_nothing_`)
    } else {
      lines.push(...activeItems)
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
        active: String(queuedTasks.length + activeTasks.length),
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
  - queued, claimed, and running tasks (work in the pipeline)

  ### Stale / failed
  - stale runs and failed tasks

Notes:
  - as_of_event_id is the latest event ID at render time; use it as a briefing watermark.
  - Cancelled tasks are excluded.
  - The renderer formats raw facts; Pandora interprets them. No summarisation in code.

Examples:
  pithos briefing
  pithos briefing --agent pandora

Exit codes: 0 success | 2 validation error
`
