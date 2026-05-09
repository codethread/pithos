import { Effect, Metric, Schema } from "effect";
import { DbService } from "../services/db.ts";
import { OutputService } from "../services/output.ts";
import { PithosError } from "../errors/errors.ts";
import { TaskRow } from "../db/rows.ts";
import { tasksClaimedCounter, withCommandObservability } from "../layers/metrics.ts";
import { sql } from "../db/sql.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ClaimOptions {
	readonly run: string | undefined;
	readonly scope: string | undefined;
	readonly capability: string | undefined;
	readonly leaseMinutes?: number | undefined;
}

const DEFAULT_LEASE_MINUTES = 10;
const CapabilitySchema = Schema.Literal("triage", "design", "execute", "escalate");

class RunHeldTaskRow extends Schema.Class<RunHeldTaskRow>("RunHeldTaskRow")({
	task_id: Schema.NullOr(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// pithos claim
// ---------------------------------------------------------------------------

/**
 * `pithos claim --run <run-id> --scope <scope-id> --capability <cap> [--lease-minutes <n>]`
 *
 * Atomically claims the oldest ready queued task matching the scope and capability.
 * A queued task is ready only when all direct dependencies are already `done`.
 * In a single transaction:
 *  - Sets status = 'claimed', lease_owner_run_id, lease_until
 *  - Increments fencing_token and attempts
 *  - Appends a task.claimed event
 *
 * Exits with code 5 (NO_CLAIMABLE_WORK) when no matching queued task exists.
 * Exits with code 3 (NOT_FOUND) when the specified run does not exist.
 */
export const claimCommand = (
	opts: ClaimOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
	Effect.gen(function* () {
		if (!opts.run) {
			yield* Effect.fail(
				new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }),
			);
			return;
		}
		if (!opts.scope) {
			yield* Effect.fail(
				new PithosError({ code: "VALIDATION_ERROR", message: "--scope is required" }),
			);
			return;
		}
		if (!opts.capability) {
			yield* Effect.fail(
				new PithosError({ code: "VALIDATION_ERROR", message: "--capability is required" }),
			);
			return;
		}

		const runId = opts.run;
		const scope = opts.scope;
		const capability = yield* Schema.decodeUnknown(CapabilitySchema)(opts.capability).pipe(
			Effect.mapError(
				() =>
					new PithosError({
						code: "VALIDATION_ERROR",
						message: `Invalid --capability value: '${opts.capability}'. Valid values: triage, design, execute, escalate`,
					}),
			),
		);
		const leaseMinutes = opts.leaseMinutes ?? DEFAULT_LEASE_MINUTES;

		if (!Number.isFinite(leaseMinutes) || leaseMinutes <= 0) {
			yield* Effect.fail(
				new PithosError({
					code: "VALIDATION_ERROR",
					message: `--lease-minutes must be a positive number, got: ${String(leaseMinutes)}`,
				}),
			);
			return;
		}

		const db = yield* DbService;
		const output = yield* OutputService;

		// Validate run exists before attempting the claim transaction.
		const runRows = yield* db.query(sql`SELECT id FROM runs WHERE id = ?`, [runId]);
		if (runRows.length === 0) {
			yield* Effect.fail(
				new PithosError({ code: "NOT_FOUND", message: `Run not found: ${runId}` }),
			);
			return;
		}

		// Atomic claim: single transaction, no select-then-update race.
		//
		// TODO: test cross-process contention. In-process tests (claim.test.ts +
		// claim-sqlite.integration.test.ts) verify the state-machine invariant
		// (first claim wins, second fails) but cannot simulate true concurrent
		// processes inside the critical section. A proper race test needs a
		// synchronization barrier (e.g. test-only env hook / named pipe / file
		// lock) that holds all N processes at the transaction boundary and
		// releases them together, then asserts exactly M < N succeed with no
		// duplicate owners. Without this, a regression in SQLite's locking mode
		// or the UPDATE RETURNING atomicity would not be caught.
		const claimedTask = yield* db.withTransaction(
			Effect.gen(function* () {
				const runStateRows = yield* db.query(sql`SELECT task_id FROM runs WHERE id = ?`, [runId]);
				if (runStateRows.length !== 1) {
					yield* Effect.fail(
						new PithosError({
							code: "INTERNAL_ERROR",
							message: `Run precondition query returned ${runStateRows.length} rows for ${runId}`,
						}),
					);
					return yield* Effect.never;
				}
				const runState = yield* Schema.decodeUnknown(RunHeldTaskRow)(runStateRows[0]!).pipe(
					Effect.mapError(
						() =>
							new PithosError({
								code: "INTERNAL_ERROR",
								message: "Run held-task row shape violation from DB",
							}),
					),
				);
				if (runState.task_id !== null) {
					yield* Effect.fail(
						new PithosError({
							code: "USER_ERROR",
							message: `Run ${runId} already holds task ${runState.task_id}`,
						}),
					);
					return yield* Effect.never;
				}

				const rows = yield* db.query(
					sql`UPDATE tasks
           SET
             status             = 'claimed',
             lease_owner_run_id = ?,
             lease_until        = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '+' || ? || ' minutes')),
             fencing_token      = fencing_token + 1,
             attempts           = attempts + 1,
             updated_at         = datetime('now')
           WHERE id = (
             SELECT t.id
             FROM tasks t
             WHERE t.status     = 'queued'
               AND t.scope_id   = ?
               AND t.capability = ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM task_dependencies td
                 JOIN tasks dep ON dep.id = td.depends_on_task_id
                 WHERE td.task_id = t.id
                   AND dep.status <> 'done'
               )
             ORDER BY t.created_at ASC, t.id ASC
             LIMIT 1
           )
           RETURNING *`,
					[runId, leaseMinutes, scope, capability],
				);

				if (rows.length === 0) return null;

				// Decode the returned row via Schema to get typed field access.
				const task = yield* Schema.decodeUnknown(TaskRow)(rows[0]!).pipe(
					Effect.mapError(
						() =>
							new PithosError({
								code: "INTERNAL_ERROR",
								message: "TaskRow shape violation from DB",
							}),
					),
				);

				const runUpdateRows = yield* db.query(
					sql`UPDATE runs
           SET task_id = ?, updated_at = datetime('now')
           WHERE id = ?
             AND task_id IS NULL
           RETURNING task_id`,
					[task.id, runId],
				);
				if (runUpdateRows.length !== 1) {
					yield* Effect.fail(
						new PithosError({
							code: "USER_ERROR",
							message: `Run ${runId} already holds a task; claim rolled back`,
						}),
					);
					return yield* Effect.never;
				}
				yield* Schema.decodeUnknown(RunHeldTaskRow)(runUpdateRows[0]!).pipe(
					Effect.mapError(
						() =>
							new PithosError({
								code: "INTERNAL_ERROR",
								message: "Run update row shape violation from DB",
							}),
					),
				);

				yield* db.run(
					sql`INSERT INTO events (task_id, actor_run_id, type, payload_json)
           VALUES (?, ?, 'task.claimed', ?)`,
					[
						task.id,
						runId,
						JSON.stringify({
							run_id: runId,
							fencing_token: task.fencing_token,
							lease_until: task.lease_until,
						}),
					],
				);

				return task;
			}),
		);

		if (claimedTask === null) {
			yield* Effect.logDebug("no claimable work").pipe(Effect.annotateLogs({ scope, capability }));
			yield* Effect.fail(
				new PithosError({ code: "NO_CLAIMABLE_WORK", message: "no claimable work found" }),
			);
			return;
		}

		yield* Metric.increment(tasksClaimedCounter);
		yield* Effect.logDebug("task claimed").pipe(
			Effect.annotateLogs({ taskId: claimedTask.id, runId }),
		);
		yield* output.print(JSON.stringify({ ok: true, task: claimedTask }));
	}).pipe(Effect.withLogSpan("pithos.claim"), withCommandObservability("claim"));

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const CLAIM_HELP = `pithos claim - Atomically claim one queued task for a run

Usage:
  pithos claim --run <run-id> --scope <scope-id> --capability <cap> [options]

Options:
  --run <run-id>         Run ID claiming the task [required]
  --scope <scope-id>     Scope to search within [required]
  --capability <cap>     Task capability to match [required]
  --lease-minutes <n>    Lease duration in minutes (default: 10)
  --help, -h             Show this help

Output (JSON, success):
  { "ok": true, "task": { "id": "task_...", "scope_id": "...", "capability": "...", "fencing_token": 1, "lease_until": "...", ... } }

Output (JSON, no work):
  { "ok": false, "error": "no_claimable_work" }

Notes:
  - Claims the oldest ready queued task matching the scope and capability (FIFO among claimable work).
  - Queued tasks with unresolved dependencies stay queued and are skipped until every direct blocker is done.
  - The fencing_token must be passed to complete/fail/heartbeat commands.
  - A run can hold only one task at a time; complete/fail the held task before claiming again.
  - A task can only be held by one run; concurrent claims are safe.

Examples:
  pithos claim --run run_abc --scope global --capability triage
  pithos claim --run run_abc --scope repo:work/perkbox/protobuf --capability execute --lease-minutes 20

Exit codes: 0 success | 2 validation error | 3 not found (run) | 5 no claimable work
`;
