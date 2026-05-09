import { Effect, Schema } from "effect";
import { TaskRow } from "../db/rows.ts";
import { PithosError } from "../errors/errors.ts";
import { withCommandObservability } from "../layers/metrics.ts";
import { DbService } from "../services/db.ts";
import { OutputService } from "../services/output.ts";
import { sql } from "../db/sql.ts";

class IdRow extends Schema.Class<IdRow>("IdRow")({
	id: Schema.String,
}) {}

interface TaskCancelledEventPayload {
	readonly reason: string;
}

const decodeTaskRow = (row: unknown): Effect.Effect<TaskRow, PithosError> =>
	Schema.decodeUnknown(TaskRow)(row).pipe(
		Effect.mapError(
			() =>
				new PithosError({
					code: "INTERNAL_ERROR",
					message: "TaskRow shape violation from DB",
				}),
		),
	);

const decodeIdRow = (row: unknown): Effect.Effect<IdRow, PithosError> =>
	Schema.decodeUnknown(IdRow)(row).pipe(
		Effect.mapError(
			() =>
				new PithosError({
					code: "INTERNAL_ERROR",
					message: "id row shape violation",
				}),
		),
	);

export interface CancelOptions {
	readonly taskId: string | undefined;
	readonly run: string | undefined;
	readonly reason: string | undefined;
}

export const cancelCommand = (
	opts: CancelOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
	Effect.gen(function* () {
		if (!opts.taskId) {
			yield* Effect.fail(
				new PithosError({ code: "VALIDATION_ERROR", message: "task id argument is required" }),
			);
			return;
		}
		if (!opts.run) {
			yield* Effect.fail(
				new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }),
			);
			return;
		}
		if (opts.reason === undefined) {
			yield* Effect.fail(
				new PithosError({ code: "VALIDATION_ERROR", message: "--reason is required" }),
			);
			return;
		}

		const taskId = opts.taskId;
		const runId = opts.run;
		const reason = opts.reason.trim();

		if (reason.length === 0) {
			yield* Effect.fail(
				new PithosError({ code: "VALIDATION_ERROR", message: "--reason must be non-empty" }),
			);
			return;
		}

		const db = yield* DbService;
		const output = yield* OutputService;

		const cancelledTask = yield* db.withTransaction(
			Effect.gen(function* () {
				const taskRows = yield* db.query(sql`SELECT * FROM tasks WHERE id = ?`, [taskId]);
				if (taskRows.length === 0) {
					yield* Effect.fail(
						new PithosError({ code: "NOT_FOUND", message: `Task not found: ${taskId}` }),
					);
					return yield* Effect.never;
				}
				const task = yield* decodeTaskRow(taskRows[0]!);

				const runRows = yield* db.query(sql`SELECT id FROM runs WHERE id = ?`, [runId]);
				if (runRows.length === 0) {
					yield* Effect.fail(
						new PithosError({ code: "NOT_FOUND", message: `Run not found: ${runId}` }),
					);
					return yield* Effect.never;
				}
				yield* decodeIdRow(runRows[0]!);

				if (task.status !== "queued" && task.status !== "failed" && task.status !== "dead_letter") {
					yield* Effect.fail(
						new PithosError({
							code: "USER_ERROR",
							message: `Cannot cancel task ${taskId} while it is ${task.status}`,
						}),
					);
					return yield* Effect.never;
				}

				const cancelledRows = yield* db.query(
					sql`UPDATE tasks
             SET status = 'cancelled', updated_at = datetime('now')
             WHERE id = ?
               AND status IN ('queued', 'failed', 'dead_letter')
             RETURNING *`,
					[taskId],
				);
				if (cancelledRows.length !== 1) {
					yield* Effect.fail(
						new PithosError({
							code: "INTERNAL_ERROR",
							message: `Task cancellation affected ${cancelledRows.length} rows for task ${taskId}`,
						}),
					);
					return yield* Effect.never;
				}
				const cancelled = yield* decodeTaskRow(cancelledRows[0]!);

				const taskCancelledEventPayload = {
					reason,
				} satisfies TaskCancelledEventPayload;

				yield* db.run(
					sql`INSERT INTO events (task_id, actor_run_id, type, payload_json)
           VALUES (?, ?, 'task.cancelled', ?)`,
					[taskId, runId, JSON.stringify(taskCancelledEventPayload)],
				);

				return cancelled;
			}),
		);

		yield* Effect.logDebug("task cancelled").pipe(Effect.annotateLogs({ taskId, runId, reason }));

		yield* output.print(
			JSON.stringify({
				ok: true,
				task: {
					id: cancelledTask.id,
					status: cancelledTask.status,
					scope_id: cancelledTask.scope_id,
					capability: cancelledTask.capability,
				},
			}),
		);
	}).pipe(Effect.withLogSpan("pithos.cancel"), withCommandObservability("cancel"));

export const CANCEL_HELP = `pithos cancel - Cancel queued, failed, or dead-lettered work

Usage:
  pithos cancel <task-id> --run <run-id> --reason <text>

Arguments:
  <task-id>          Task ID to cancel [required]

Options:
  --run <run-id>     Run ID performing the cancellation [required]
  --reason <text>    Human-readable cancellation reason [required]
  --help, -h         Show this help

Output (JSON):
  { "ok": true, "task": { "id": "task_...", "status": "cancelled", "scope_id": "...", "capability": "..." } }

Notes:
  - Cancels only queued, failed, or dead_letter tasks.
  - Rejects claimed, running, done, and already-cancelled tasks.
  - Emits task.cancelled with the supplied reason.

Examples:
  pithos cancel task_old --run run_pandora --reason "No longer needed"

Exit codes: 0 success | 1 user error | 2 validation error | 3 not found
`;
