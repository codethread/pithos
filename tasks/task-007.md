# Slice 7 — pdx kill flow

## What to build

Implement `pdx kill (--run <run-id> | --task <task-id>) --reason <text> [--home <path>]` in `packages/pdx/` per spec §8.

Sequence:

1. If `--task <id>` is supplied and no run currently holds that task (per Pithos DB lookup, not Registry), reject with a tagged error pointing the operator to `pithos task cancel`. `Kill` acts on a live run; non-held task abandonment is `Cancel`.
2. `pithos run interrupt` (`--run` or `--task`). The interrupt itself resolves owning run from Pithos DB (already implemented in slice 2). Zero active owning runs → fail loud.
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

## Acceptance criteria

- [ ] `pdx kill` implements full sequence per spec §8
- [ ] `--task` lookup uses Pithos DB; rejects on zero owning runs
- [ ] Non-held `--task` rejected with helpful pointer to `pithos task cancel`
- [ ] Escalate task authored by pdx system run, scope=global, body references original
- [ ] Retry-until-gone behavior verified across reconcile ticks
- [ ] Each retry emits a structured supervisor log line

## Blocked by

- Slice 2 (task-002)
- Slice 6 (task-006)
