# Slice 10 — Orphan discovery on `pdx open`

## What to build

Add daemon startup settlement to `pdx open` in `packages/pdx/`, matching the supervision spec order. All Pithos reads/writes in this slice go through pdx's direct `@pithos/pithos` boundary, not the CLI.

1. `pdx open` starts the new `pdx--daemon` tmux session.
2. During daemon startup, before the `pdx` system run or Pandora are created, the daemon settles old execution resources.
3. After settlement succeeds, normal startup continues with system run upsert and Pandora launch.

Important naming exception: the new `pdx--daemon` session is not an orphan. HITL orphan cleanup must not kill the daemon session that is currently performing startup settlement.

HITL orphans:

- `tmux ls -F '#S'` filtered by regex `^pdx--`.
- Exclude the current `pdx--daemon` session.
- Kill each remaining matching session.

AFK orphans:

- Walk pidfiles under `<home>/runs/*.pid`. For each pidfile:
  - Parse run id from the filename.
  - If `kill(pid, 0)` reports the process is alive: kill the process, confirm gone, then `pithos run cleanup` for the run id with reason `daemon_start`. Remove the pidfile.
  - If the process is gone (stale pidfile): `pithos run cleanup` for the run id only — no kill attempt. Remove the pidfile.

After both lists are processed, confirm execution resources are gone, then continue with normal daemon startup.

This is the only path that adopts pre-existing child agent resources. Steady-state reconcile never adopts; it only observes/cleans entries it created. An already-existing `pdx--daemon` session is still handled by task-005b's fail-loud precondition, not by this orphan cleanup path.

## Test focus

- HITL orphan sessions matching `^pdx--` are killed; non-matching tmux sessions are left alone.
- The current `pdx--daemon` session is not killed as an orphan.
- AFK orphan with live pid: kill is invoked, gone is confirmed, `run cleanup` is called, pidfile removed.
- AFK orphan with stale pid: no kill attempt, `run cleanup` called, pidfile removed.
- `kill(pid, 0)` failure on a missing pid does not raise — the stale path handles it.
- Idempotent re-open: after the previous daemon session is gone, a partial cleanup that leaves only child sessions/pidfiles behind allows the next `pdx open` to succeed cleanly.
- Orphan discovery completes before pdx system run or Pandora are created.

Defer: race conditions between probe and kill (MVP); operator-created tmux sessions named `pdx--*` outside pdx's lifecycle (treated as orphans by design).

## Implementation primitives

Builds on task-005a Tmux/FileSystem services, task-005b daemon startup, task-002 `pithos run cleanup`, and task-006a's direct Pithos library adapter.

- **Order:** daemon startup settlement runs after `pdx--daemon` exists, before `pdx` system run upsert and Pandora launch.
- **HITL orphans:** `Tmux.lsSessions()` returns all session names; filter by `^pdx--`, then exclude the current daemon target. For each match: `Tmux.killSession(name)`.
- **AFK orphans:** `FileSystem.readDirectory("<home>/runs/")` for `*.pid` entries. For each:
  - Parse `runId` from filename (`<run-id>.pid`).
  - Read pid via `FileSystem.readFileString` and parse as integer; malformed → fail loud with `VALIDATION_ERROR`.
  - Probe alive via the `Process` service (`kill(pid, 0)` semantics). ESRCH → dead.
  - Alive: send `SIGTERM`, confirm gone, retry `SIGKILL` if needed; then `pithos.run.cleanup({ run: runId, reason: "daemon_start" })` through the direct library adapter; remove pidfile.
  - Dead: only `pithos.run.cleanup({ run: runId, reason: "daemon_start" })` through the direct library adapter; remove pidfile. No kill attempt.
- **Pidfile persistence is intentional:** crashed-pdx leaves pidfiles in place so the next `pdx open` finds and reaps them. No auto-cleanup-on-process-exit helper.
- **Idempotency:** running orphan discovery twice in a row is safe. After the first pass clears everything, the second is a no-op.

## Acceptance criteria

- [ ] Startup settlement runs inside daemon startup before system run/Pandora creation
- [ ] Current `pdx--daemon` session is preserved
- [ ] tmux orphans matched by `^pdx--` are killed
- [ ] Live-pid pidfile orphans are killed, confirmed gone, and cleaned up
- [ ] Stale pidfile orphans are cleaned up without a failed kill attempt
- [ ] `pdx open` succeeds cleanly after a previous unclean shutdown once no old daemon session remains
