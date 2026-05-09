# Slice 8d — No-claim timeout

## What to build

Implement the non-Pandora No-claim session timeout in pdx reconcile.

Definition:

- Applies only to spawnable non-Pandora Registry entries.
- Excludes Pandora and the `pdx` system run.
- Hardcoded 30 seconds in MVP.
- Applies only to entries that have never held a task.
- Once a run has ever held a task, later idle/null `runs.task_id` periods are not No-claim sessions.

Registry additions:

- `launchedAt`
- `everClaimed`

Each reconcile tick:

1. Observe each spawnable Registry entry.
2. If `runs.task_id` is non-null for that run, set `everClaimed = true` permanently.
3. If `everClaimed === false` and `now - launchedAt >= 30s`:
   - kill the registered process/tmux session
   - confirm the execution resource is gone
   - call the direct `@pithos/pithos` operation equivalent to `pithos run timeout --run <id> --reason no_claim_timeout`
   - remove the Registry entry and release caps

Rules:

- No task is mutated by timeout.
- If the run holds a task at timeout check time, fail loudly or mark `everClaimed`; do not call `run timeout` on a held task.
- Cleanup is not the timeout transition; use the direct Pithos `run timeout` library operation.

## Test focus

- Timeout fires at 30s for a never-claimed spawnable entry.
- Timeout never fires for Pandora.
- Timeout never fires for `pdx` system run.
- Timeout does not fire for an entry that previously held a task and is now idle.
- Timeout kills/confirms gone before `pithos run timeout`.
- `pithos run timeout` rejection on held task is not swallowed.
- Registry entry removed and caps released only after timeout settlement.

## Defer

- Retry policy for stubborn kill failures beyond existing terminating/retry behavior from task 007.
- Startup pidfile orphan timeout handling; task 010 uses cleanup, not timeout.

## Acceptance criteria

- [ ] Non-Pandora never-claimed runs time out after 30s
- [ ] Timeout calls Pithos `run timeout` only after execution resource is gone
- [ ] Pandora, `pdx`, and previously-claimed idle runs are excluded
- [ ] Timeout does not mutate tasks
