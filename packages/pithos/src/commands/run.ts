import { Effect, Schema } from "effect"
import {
  decodeIdRow,
  decodeRunRow,
  decodeTaskRow,
  loadRequiredRunRow,
  loadRequiredScopeRow,
  loadRequiredTaskRow,
} from "../db/helpers.ts"
import type { RunRow, TaskRow } from "../db/rows.ts"
import { decodeAgentKind, decodeRunMode } from "../domain/auth.ts"
import { AGENT_KINDS } from "../domain/control-plane.ts"
import { TERMINAL_RUN_STATUSES, toRunOutput } from "../domain/run.ts"
import { PithosError } from "../errors/errors.ts"
import { withCommandObservability } from "../layers/metrics.ts"
import { DbService } from "../services/db.ts"
import type { DbRow } from "../services/db.ts"
import { IdService } from "../services/ids.ts"
import { OutputService } from "../services/output.ts"

export interface RunUpsertOptions {
  readonly agent: string | undefined
  readonly mode: string | undefined
  readonly scope: string | undefined
  readonly cwd: string | undefined
  readonly sessionId: string | undefined
  readonly run?: string | undefined
}

export interface RunCleanupOptions {
  readonly run: string | undefined
  readonly reason: string | undefined
}

export interface RunInterruptOptions {
  readonly run?: string | undefined
  readonly task?: string | undefined
  readonly reason: string | undefined
}

export interface RunTimeoutOptions {
  readonly run: string | undefined
  readonly reason: string | undefined
}

const NonEmptyString = Schema.NonEmptyString

const decodeRequiredText = (
  raw: string | undefined,
  name: string,
): Effect.Effect<string, PithosError> =>
  raw === undefined
    ? Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: `${name} is required` }))
    : Schema.decodeUnknown(NonEmptyString)(raw).pipe(
        Effect.mapError(
          () =>
            new PithosError({
              code: "VALIDATION_ERROR",
              message: `${name} must be a non-empty string`,
            }),
        ),
      )

interface DbOps {
  readonly query: (
    sql: string,
    params?: readonly unknown[],
  ) => Effect.Effect<readonly DbRow[], PithosError>
  readonly run: (
    sql: string,
    params?: readonly unknown[],
  ) => Effect.Effect<void, PithosError>
  readonly withTransaction: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | PithosError>
}

type RunSnapshot =
  | { readonly kind: "terminal"; readonly run: RunRow }
  | { readonly kind: "no_task"; readonly run: RunRow }
  | { readonly kind: "active_task"; readonly run: RunRow; readonly task: TaskRow }
  | { readonly kind: "terminal_task"; readonly run: RunRow; readonly task: TaskRow }

const ACTIVE_TASK_STATUSES = new Set(["claimed", "running"])
const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "dead_letter", "cancelled"])

const classifyRunSnapshot = (
  run: RunRow,
  task: TaskRow | null,
): Effect.Effect<RunSnapshot, PithosError> =>
  Effect.gen(function* () {
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return { kind: "terminal", run } as const
    }

    if (run.task_id === null) {
      return { kind: "no_task", run } as const
    }

    if (task === null) {
      return yield* Effect.fail(
        new PithosError({
          code: "INTERNAL_ERROR",
          message: `Run ${run.id} references missing task ${run.task_id}`,
        }),
      )
    }

    if (ACTIVE_TASK_STATUSES.has(task.status)) {
      return { kind: "active_task", run, task } as const
    }

    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      return { kind: "terminal_task", run, task } as const
    }

    return yield* Effect.fail(
      new PithosError({
        code: "INTERNAL_ERROR",
        message: `Unsupported held task status for run ${run.id}: ${task.status}`,
      }),
    )
  })

const loadRunSnapshot = (
  db: DbOps,
  runId: string,
): Effect.Effect<RunSnapshot, PithosError> =>
  Effect.gen(function* () {
    const run = yield* loadRequiredRunRow(db, runId)
    const task = run.task_id === null ? null : yield* loadRequiredTaskRow(db, run.task_id)
    return yield* classifyRunSnapshot(run, task)
  })

const updateRunStatus = (
  db: DbOps,
  run: RunRow,
  status: RunRow["status"],
  taskId: string | null,
): Effect.Effect<RunRow, PithosError> =>
  Effect.gen(function* () {
    const rows = yield* db.query(
      `UPDATE runs
       SET
         status = ?,
         task_id = ?,
         updated_at = CURRENT_TIMESTAMP,
         ended_at = CASE
           WHEN ? IN ('ended', 'failed', 'cancelled', 'timed_out') THEN CURRENT_TIMESTAMP
           ELSE ended_at
         END
       WHERE id = ?
         AND status = ?
         AND ((task_id IS NULL AND ? IS NULL) OR task_id = ?)
       RETURNING *`,
      [status, taskId, status, run.id, run.status, run.task_id, run.task_id],
    )

    if (rows.length === 0) {
      yield* Effect.fail(
        new PithosError({
          code: "STALE_TOKEN_RACE",
          message: `concurrent run update invalidated transition for ${run.id}`,
        }),
      )
    }

    return yield* decodeRunRow(rows[0]!)
  })

const emitRunEvent = (
  db: DbOps,
  eventType: "run.cleanup" | "run.interrupted" | "run.timed_out",
  run: RunRow,
  nextRun: RunRow,
  reason: string,
): Effect.Effect<void, PithosError> =>
  db.run(
    `INSERT INTO events (run_id, type, payload_json)
     VALUES (?, ?, ?)`,
    [
      run.id,
      eventType,
      JSON.stringify({
        reason,
        previous_status: run.status,
        status: nextRun.status,
        ...(run.task_id === null ? {} : { task_id: run.task_id }),
      }),
    ],
  )

const reclaimActiveTask = (
  db: DbOps,
  run: RunRow,
  task: TaskRow,
  reason: string,
): Effect.Effect<{ readonly run: RunRow; readonly task: TaskRow }, PithosError> =>
  Effect.gen(function* () {
    const nextTaskStatus = task.attempts < task.max_attempts ? "queued" : "dead_letter"
    const eventType = nextTaskStatus === "queued" ? "task.reclaimed" : "task.dead_lettered"

    const taskRows = yield* db.query(
      `UPDATE tasks
       SET
         status = ?,
         fencing_token = fencing_token + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND status = ?
         AND fencing_token = ?
         AND EXISTS (
           SELECT 1
           FROM runs
           WHERE id = ?
             AND task_id = tasks.id
             AND status = ?
         )
       RETURNING *`,
      [nextTaskStatus, task.id, task.status, task.fencing_token, run.id, run.status],
    )

    if (taskRows.length === 0) {
      yield* Effect.fail(
        new PithosError({
          code: "STALE_TOKEN_RACE",
          message: "concurrent reclaim invalidated the token",
        }),
      )
    }

    const nextTask = yield* decodeTaskRow(taskRows[0]!)
    yield* db.run(
      `INSERT INTO events (task_id, run_id, type, payload_json)
       VALUES (?, ?, ?, ?)`,
      [
        task.id,
        run.id,
        eventType,
        JSON.stringify({
          previous_run_id: run.id,
          reason,
          attempts: task.attempts,
          max_attempts: task.max_attempts,
          previous_fencing_token: task.fencing_token,
          new_fencing_token: nextTask.fencing_token,
        }),
      ],
    )

    const nextRun = yield* updateRunStatus(db, run, "failed", null)
    yield* emitRunEvent(db, "run.cleanup", run, nextRun, reason)

    return { run: nextRun, task: nextTask }
  })

const interruptActiveTask = (
  db: DbOps,
  run: RunRow,
  task: TaskRow,
  reason: string,
): Effect.Effect<{ readonly run: RunRow; readonly task: TaskRow }, PithosError> =>
  Effect.gen(function* () {
    const taskRows = yield* db.query(
      `UPDATE tasks
       SET
         status = 'failed',
         result_json = ?,
         fencing_token = fencing_token + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND status = ?
         AND fencing_token = ?
         AND EXISTS (
           SELECT 1
           FROM runs
           WHERE id = ?
             AND task_id = tasks.id
             AND status = ?
         )
       RETURNING *`,
      [JSON.stringify({ reason }), task.id, task.status, task.fencing_token, run.id, run.status],
    )

    if (taskRows.length === 0) {
      yield* Effect.fail(
        new PithosError({
          code: "STALE_TOKEN_RACE",
          message: "concurrent interrupt invalidated the token",
        }),
      )
    }

    const nextTask = yield* decodeTaskRow(taskRows[0]!)
    yield* db.run(
      `INSERT INTO events (task_id, run_id, type, payload_json)
       VALUES (?, ?, 'task.interrupted', ?)`,
      [
        task.id,
        run.id,
        JSON.stringify({
          run_id: run.id,
          reason,
          previous_status: task.status,
          previous_fencing_token: task.fencing_token,
          new_fencing_token: nextTask.fencing_token,
        }),
      ],
    )

    const nextRun = yield* updateRunStatus(db, run, "failed", null)
    yield* emitRunEvent(db, "run.interrupted", run, nextRun, reason)

    return { run: nextRun, task: nextTask }
  })

const settleTerminalHeldTask = (
  db: DbOps,
  run: RunRow,
  task: TaskRow,
  eventType: "run.cleanup" | "run.interrupted",
  reason: string,
): Effect.Effect<RunRow, PithosError> =>
  Effect.gen(function* () {
    const nextRunStatus = task.status === "done" ? "ended" : "failed"
    const nextRun = yield* updateRunStatus(db, run, nextRunStatus, null)
    yield* emitRunEvent(db, eventType, run, nextRun, reason)
    return nextRun
  })

type InterruptSelector =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "task"; readonly taskId: string }

const decodeInterruptSelector = (
  opts: RunInterruptOptions,
): Effect.Effect<InterruptSelector, PithosError> =>
  Effect.gen(function* () {
    const explicitRun = opts.run === undefined ? undefined : yield* decodeRequiredText(opts.run, "--run")
    const taskId = opts.task === undefined ? undefined : yield* decodeRequiredText(opts.task, "--task")

    if ((explicitRun === undefined) === (taskId === undefined)) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: "Supply exactly one of --run or --task",
        }),
      )
    }

    return explicitRun !== undefined
      ? ({ kind: "run", runId: explicitRun } as const)
      : ({ kind: "task", taskId: taskId! } as const)
  })

const resolveInterruptRunId = (
  db: DbOps,
  selector: InterruptSelector,
): Effect.Effect<string, PithosError> =>
  Effect.gen(function* () {
    if (selector.kind === "run") {
      return selector.runId
    }

    const rows = yield* db.query(
      `SELECT id
       FROM runs
       WHERE task_id = ?
         AND status NOT IN ('ended', 'failed', 'cancelled', 'timed_out')`,
      [selector.taskId],
    )

    if (rows.length === 0) {
      yield* Effect.fail(
        new PithosError({
          code: "USER_ERROR",
          message:
            `No active run holds task ${selector.taskId}. Use pithos task cancel for non-held task abandonment.`,
        }),
      )
    }

    const row = yield* decodeIdRow(rows[0]!)
    return row.id
  })

export const runUpsertCommand = (
  opts: RunUpsertOptions,
): Effect.Effect<void, PithosError, DbService | IdService | OutputService> =>
  Effect.gen(function* () {
    const agent = yield* decodeAgentKind(opts.agent)
    const mode = yield* decodeRunMode(opts.mode)
    const scopeId = yield* decodeRequiredText(opts.scope, "--scope")
    const cwd = yield* decodeRequiredText(opts.cwd, "--cwd")
    const sessionId = yield* decodeRequiredText(opts.sessionId, "--session-id")
    const explicitRunId =
      opts.run === undefined ? undefined : yield* decodeRequiredText(opts.run, "--run")

    const db = yield* DbService
    const ids = yield* IdService
    const output = yield* OutputService

    yield* loadRequiredScopeRow(db, scopeId)

    const runId = explicitRunId ?? (yield* ids.generate("run"))
    const run = yield* db.withTransaction(
      Effect.gen(function* () {
        const existingRows = yield* db.query(`SELECT * FROM runs WHERE id = ?`, [runId])
        if (existingRows.length > 0) {
          const existing = yield* decodeRunRow(existingRows[0]!)
          const mismatches = [
            ["agent", existing.agent_kind, agent],
            ["mode", existing.mode, mode],
            ["scope", existing.scope_id, scopeId],
            ["cwd", existing.cwd, cwd],
            ["session-id", existing.session_id, sessionId],
          ].filter(([, actual, expected]) => actual !== expected)

          const canReopenPdxSystemRun =
            existing.agent_kind === "pdx" &&
            agent === "pdx" &&
            existing.mode === mode &&
            existing.scope_id === scopeId &&
            TERMINAL_RUN_STATUSES.has(existing.status)

          if (mismatches.length > 0 && !canReopenPdxSystemRun) {
            yield* Effect.fail(
              new PithosError({
                code: "VALIDATION_ERROR",
                message:
                  `Run ${runId} already exists with different immutable fields: ` +
                  mismatches
                    .map(([field, actual, expected]) => `${field}=${JSON.stringify(actual)} (wanted ${JSON.stringify(expected)})`)
                    .join(", "),
              }),
            )
          }

          if (canReopenPdxSystemRun) {
            const reopenedRows = yield* db.query(
              `UPDATE runs
               SET
                 status = 'starting',
                 task_id = NULL,
                 cwd = ?,
                 session_id = ?,
                 updated_at = CURRENT_TIMESTAMP,
                 ended_at = NULL
               WHERE id = ?
               RETURNING *`,
              [cwd, sessionId, runId],
            )

            if (reopenedRows.length === 0) {
              yield* Effect.fail(
                new PithosError({
                  code: "INTERNAL_ERROR",
                  message: `run upsert returned no reopened row for ${runId}`,
                }),
              )
            }

            return yield* decodeRunRow(reopenedRows[0]!)
          }

          return existing
        }

        const insertedRows = yield* db.query(
          `INSERT INTO runs
             (id, agent_kind, mode, scope_id, task_id, harness, session_id, tmux_target, cwd, status, last_heartbeat_at, metadata_json, ended_at)
           VALUES (?, ?, ?, ?, NULL, 'claude-code', ?, NULL, ?, 'starting', NULL, '{}', NULL)
           RETURNING *`,
          [runId, agent, mode, scopeId, sessionId, cwd],
        )

        if (insertedRows.length === 0) {
          yield* Effect.fail(
            new PithosError({
              code: "INTERNAL_ERROR",
              message: `run upsert returned no row for ${runId}`,
            }),
          )
        }

        return yield* decodeRunRow(insertedRows[0]!)
      }),
    )
    yield* Effect.logDebug("run upserted").pipe(
      Effect.annotateLogs({ runId, agent, mode, scopeId }),
    )
    yield* output.print(JSON.stringify({ ok: true, run: toRunOutput(run) }))
  }).pipe(Effect.withLogSpan("pithos.run.upsert"), withCommandObservability("run.upsert"))

export const listActiveBuiltInRunsCommand = (): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    const rows = yield* db.query(
      `SELECT *
       FROM runs
       WHERE agent_kind IN (${AGENT_KINDS.map(() => "?").join(", ")})
         AND status NOT IN (${[...TERMINAL_RUN_STATUSES].map(() => "?").join(", ")})
       ORDER BY id ASC`,
      [...AGENT_KINDS, ...TERMINAL_RUN_STATUSES],
    )

    const runs = yield* Effect.forEach(rows, (row) => decodeRunRow(row))
    yield* output.print(JSON.stringify({ ok: true, runs: runs.map((run) => toRunOutput(run)) }))
  }).pipe(Effect.withLogSpan("pithos.run.active-builtins"), withCommandObservability("run.active-builtins"))

export const runCleanupCommand = (
  opts: RunCleanupOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const runId = yield* decodeRequiredText(opts.run, "--run")
    const reason = yield* decodeRequiredText(opts.reason, "--reason")

    const db = yield* DbService
    const output = yield* OutputService

    const nextRun = yield* db.withTransaction(
      Effect.gen(function* () {
        const snapshot = yield* loadRunSnapshot(db, runId)

        switch (snapshot.kind) {
          case "terminal":
            return snapshot.run
          case "no_task": {
            const updatedRun = yield* updateRunStatus(db, snapshot.run, "ended", null)
            yield* emitRunEvent(db, "run.cleanup", snapshot.run, updatedRun, reason)
            return updatedRun
          }
          case "terminal_task":
            return yield* settleTerminalHeldTask(db, snapshot.run, snapshot.task, "run.cleanup", reason)
          case "active_task":
            return (yield* reclaimActiveTask(db, snapshot.run, snapshot.task, reason)).run
        }
      }),
    )

    yield* Effect.logDebug("run cleaned up").pipe(Effect.annotateLogs({ runId, reason }))
    yield* output.print(JSON.stringify({ ok: true, run: toRunOutput(nextRun) }))
  }).pipe(Effect.withLogSpan("pithos.run.cleanup"), withCommandObservability("run.cleanup"))

export const runInterruptCommand = (
  opts: RunInterruptOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const reason = yield* decodeRequiredText(opts.reason, "--reason")
    const selector = yield* decodeInterruptSelector(opts)
    const db = yield* DbService
    const output = yield* OutputService

    const nextRun = yield* db.withTransaction(
      Effect.gen(function* () {
        const runId = yield* resolveInterruptRunId(db, selector)
        const snapshot = yield* loadRunSnapshot(db, runId)

        switch (snapshot.kind) {
          case "terminal":
            return snapshot.run
          case "no_task": {
            const updatedRun = yield* updateRunStatus(db, snapshot.run, "cancelled", null)
            yield* emitRunEvent(db, "run.interrupted", snapshot.run, updatedRun, reason)
            return updatedRun
          }
          case "terminal_task":
            return yield* settleTerminalHeldTask(
              db,
              snapshot.run,
              snapshot.task,
              "run.interrupted",
              reason,
            )
          case "active_task":
            return (yield* interruptActiveTask(db, snapshot.run, snapshot.task, reason)).run
        }
      }),
    )

    const logId = selector.kind === "run" ? selector.runId : selector.taskId
    yield* Effect.logDebug("run interrupted").pipe(Effect.annotateLogs({ selector: logId, reason }))
    yield* output.print(JSON.stringify({ ok: true, run: toRunOutput(nextRun) }))
  }).pipe(Effect.withLogSpan("pithos.run.interrupt"), withCommandObservability("run.interrupt"))

export const runTimeoutCommand = (
  opts: RunTimeoutOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const runId = yield* decodeRequiredText(opts.run, "--run")
    const reason = yield* decodeRequiredText(opts.reason, "--reason")

    const db = yield* DbService
    const output = yield* OutputService

    const nextRun = yield* db.withTransaction(
      Effect.gen(function* () {
        const run = yield* loadRequiredRunRow(db, runId)

        if (run.task_id !== null) {
          yield* Effect.fail(
            new PithosError({
              code: "VALIDATION_ERROR",
              message: `Run ${runId} still holds task ${run.task_id}; run timeout requires no held task`,
            }),
          )
        }

        if (run.agent_kind === "pandora") {
          yield* Effect.fail(
            new PithosError({
              code: "VALIDATION_ERROR",
              message: `Run ${runId} belongs to pandora; run timeout excludes pandora`,
            }),
          )
        }

        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          return run
        }

        const updatedRun = yield* updateRunStatus(db, run, "timed_out", null)
        yield* emitRunEvent(db, "run.timed_out", run, updatedRun, reason)
        return updatedRun
      }),
    )

    yield* Effect.logDebug("run timed out").pipe(Effect.annotateLogs({ runId, reason }))
    yield* output.print(JSON.stringify({ ok: true, run: toRunOutput(nextRun) }))
  }).pipe(Effect.withLogSpan("pithos.run.timeout"), withCommandObservability("run.timeout"))
