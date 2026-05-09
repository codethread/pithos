# Slice 7 — pdx kill flow

## What to build

Implement `pdx kill (--run <run-id> | --task <task-id>) --reason <text> [--home <path>]` in `packages/pdx/` per spec §8.

Sequence:

1. If `--task <id>` is supplied and no run currently holds that task (per durable Pithos-state lookup through the pdx Pithos library boundary, not Registry), reject with a tagged error pointing the operator to `pithos task cancel`. `Kill` acts on a live run; non-held task abandonment is `Cancel`.
2. Call the direct `@pithos/pithos` library operation equivalent to `pithos run interrupt` (`--run` or `--task`) through pdx's typed Pithos service. The interrupt itself resolves owning run from durable Pithos state (already implemented in slice 2). Zero active owning runs → fail loud.
3. If the interrupt returned a held task, the **`pdx` system run** authors a global `escalate` task referencing the original task / run / scope in the body. Body must include enough detail for Pandora to investigate (run id, task id, scope id, reason, suggested next steps per spec §6 example).
4. Mark the registry entry `terminating` so caps still count it and reconcile does not respawn while kill is in progress.
5. Kill the OS process (AFK) or tmux session (HITL) immediately.
6. Retry kill once per reconcile tick if the process/session survives. Emit a structured supervisor log entry per failed attempt. No max retry, no escalation path in MVP.
7. Remove the registry entry only after kill succeeds.

`pdx restart` is intentionally not provided. Recovery is via Pandora/Adam plus graph repair.

## Test focus

- `pdx kill --task <id>` rejection when no run holds the task; error message points to `pithos task cancel`
- `pdx kill --run <id>` against a non-existent or terminal run fails loud
- Interrupt → escalate enqueue flow:
  - escalate authored by the pdx system run
  - escalate `scope_id = global`
  - escalate body references original `run_id`, `task_id`, original scope, reason
  - fencing token incremented on the held task
- Registry entry stays `terminating` across ticks while kill is in progress; cap still counts it
- Retry: simulated kill failure on first attempt followed by success on second; entry only removed after success
- Structured supervisor log entry emitted per failed kill attempt

Defer: kill-failure observability beyond log emission; kill of a fresh same-name tmux session that was created post-kill (out of scope for MVP).

## Implementation primitives

Builds on task-005a (Tmux service, Unix socket IPC), task-006 §Implementation primitives (registry, FiberMap), and task-006a's direct Pithos library adapter.

- **`pdx kill` CLI ↔ daemon:** the CLI is a separate process. It connects to the daemon's Unix socket from task-005a, sends a JSON request `{ kind: "kill", run?: string, task?: string, reason: string }` parsed via `Schema.decodeUnknown(KillRequestSchema)` on the daemon side. Response is a JSON result; CLI prints it and exits.
- **Daemon-side sequence (one supervisor span per request):**
  1. `pithos.run.interrupt(...)` first through the direct pdx Pithos library adapter — durable state mutation before any process action.
  2. If the interrupt returned a held task: enqueue a global `escalate` task as the **pdx system run** via the same direct Pithos adapter (no special path; same auth path other agents use).
  3. `SynchronizedRef.modifyEffect(registry, ...)` to mark the entry `terminating`. Caps still count it; reconcile will not respawn while this state is set.
  4. Kill the resource: HITL → `Tmux.killSession(target)`; AFK → `Process.kill(pid, "SIGTERM")` first attempt.
  5. Reconcile retries one kill per tick until gone. **Signal escalation:** first attempt `SIGTERM`, subsequent retries `SIGKILL`. Each failed attempt emits a structured supervisor log entry (`level: warn`, `span: pdx.kill.retry`).
  6. Once gone: `FiberMap.get(observers, runId)` → `Fiber.interrupt`; remove registry entry inside another `modifyEffect`.
- **`--task <id>` non-held rejection:** before step 1, query durable Pithos state for the owning run through the pdx Pithos library boundary; zero rows → `Effect.fail(new PithosError({ code: "VALIDATION_ERROR", message: "Task <id> is not held by any active run; use 'pithos task cancel' for non-held abandonment." }))`. Do **not** consult pdx Registry — Pithos is the source of truth. If the current export lacks a typed lookup helper, add it in `@pithos/pithos` rather than duplicating SQL in pdx.

## Acceptance criteria

- [ ] `pdx kill` implements full sequence per spec §8
- [ ] `--task` lookup uses durable Pithos state through the direct library boundary; rejects on zero owning runs
- [ ] Non-held `--task` rejected with helpful pointer to `pithos task cancel`
- [ ] Escalate task authored by pdx system run, scope=global, body references original
- [ ] Retry-until-gone behavior verified across reconcile ticks
- [ ] Each retry emits a structured supervisor log line
