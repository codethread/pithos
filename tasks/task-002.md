# Slice 2 — Run lifecycle transitions: cleanup, interrupt, timeout

## What to build

Three Pithos run-transition commands in `packages/pithos/`, implementing spec §7 contracts.

`pithos run cleanup --run <id> --reason <text>` — for natural lifecycle cleanup after pdx confirms execution resource is gone. Branches:

- terminal run → no-op
- no held task → run → `ended`
- held task `done` → clear `runs.task_id`; run → `ended`
- held task `failed|dead_letter|cancelled` → clear `runs.task_id`; run → `failed`
- held task `claimed|running`:
  - attempts not incremented (attempts increment only on claim)
  - `attempts < max_attempts` → task → `queued`, increment fencing token, emit `task.reclaimed`
  - else → task → `dead_letter`, increment fencing token, emit `task.dead_lettered`
  - clear `runs.task_id`; run → `failed`

Active-task update is fenced against captured `runs.task_id`/status/fencing snapshot. Zero rows affected → fail loud and roll back.

`pithos run interrupt (--run <id> | --task <id>) --reason <text>` — for deliberate operator kill. `--task` resolves owning run via Pithos DB (`SELECT id FROM runs WHERE task_id = ?`); zero rows fails loud (do not consult pdx Registry). Branches:

- terminal run → no-op
- no held task → run → `cancelled`; no task mutation; no escalation from Pithos
- active held task → task → `failed`, increment fencing token, clear `runs.task_id`, run → `failed`, emit `task.interrupted`
- terminal held task → clear `runs.task_id`; end/fail run per task state

`pdx`, not Pithos, creates the follow-up escalation task (slice 7).

`pithos run timeout --run <id> --reason <text>` — for non-Pandora no-claim session timeout. Branches:

- only valid when `runs.task_id IS NULL`; otherwise fail loud
- terminal run → no-op
- non-terminal run with no held task → run → `timed_out`
- emit `run.timed_out`

Output minimum:

```json
{ "ok": true, "run": { "id": "run_...", "status": "timed_out" } }
```

Events emitted with minimum payload per spec §11: `task.reclaimed`, `task.dead_lettered`, `task.interrupted`, `run.cleanup`, `run.interrupted`, `run.timed_out`.

## Test focus

- Each transition outcome by precondition matrix (terminal/no-task/active/terminal-held; attempts vs max_attempts)
- Fencing token monotonically increments on requeue/dead-letter/interrupt
- `run interrupt --task` lookup including zero-result rejection
- `run timeout` rejects when task held
- Concurrent-modification rejection: fenced update affecting zero rows rolls back the transaction loudly
- `task.reclaimed`/`task.dead_lettered`/`task.interrupted` payloads include minimum fields per spec §11

Defer: exhaustive payload field coverage; performance under contention.

## Implementation primitives

SQL transaction + fenced-UPDATE patterns are canonical in task-001 §Implementation primitives. Highlights specific to this slice:

- Each transition is one `sql.withTransaction(...)` block. The fenced UPDATE on the active task captures `runs.task_id`, task `status`, and `fencing_token` in its WHERE. Zero rows affected → `STALE_TOKEN_RACE`, transaction rolls back.
- `run interrupt --task <id>` resolves the owning run via `SELECT id FROM runs WHERE task_id = ? AND status NOT IN ('ended','failed','cancelled','timed_out')`. Zero rows → `Effect.fail` (do **not** consult pdx Registry — DB is source of truth).
- Event emission is one INSERT per branch inside the same transaction so events are durable iff the state transition committed.
- Branches (terminal / no-task / active-held / terminal-held) modelled as a tagged union over a captured snapshot of run+task state, not if-chains. Prevents missed branches.

## Acceptance criteria

- [ ] All three commands implement spec §7 transition tables
- [ ] Fencing increments verified on every active-task path
- [ ] `run interrupt --task` DB-lookup behavior tested including zero-rows rejection
- [ ] `run timeout` rejects when task held
- [ ] Events emitted with required minimum payload
- [ ] Race-loss path rolls back transaction with `STALE_TOKEN_RACE` (or equivalent) tagged error
