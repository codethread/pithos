# Slice 10 — Orphan discovery on `pdx open`

## What to build

Add a startup settlement step at the front of `pdx open` in `packages/pdx/`, before the daemon, system run, or Pandora are touched.

HITL orphans:

- `tmux ls -F '#S'` filtered by regex `^pdx--`.
- Kill each matching session.

AFK orphans:

- Walk pidfiles under `<home>/runs/*.pid`. For each pidfile:
  - Parse run id from the filename.
  - If `kill(pid, 0)` reports the process is alive: kill the process, then `pithos run cleanup` for the run id with reason `daemon_start`. Remove the pidfile.
  - If the process is gone (stale pidfile): `pithos run cleanup` for the run id only — no kill attempt. Remove the pidfile.

After both lists are processed, confirm execution resources are gone, then continue with normal `pdx open` (system run upsert, daemon start, Pandora launch).

This is the only path that adopts pre-existing resources. Steady-state reconcile never adopts; it only observes/cleans entries it created.

## Test focus

- HITL orphan sessions matching `^pdx--` are killed; non-matching tmux sessions are left alone
- AFK orphan with live pid: kill is invoked, then `run cleanup` is called, pidfile removed
- AFK orphan with stale pid: no kill attempt, `run cleanup` called, pidfile removed
- `kill(pid, 0)` failure on a missing pid does not raise — the stale path handles it
- Idempotent re-open: a partial cleanup that leaves nothing behind allows the next `pdx open` to succeed cleanly
- Orphan discovery completes before the new daemon, pdx system run, or Pandora are created

Defer: race conditions between probe and kill (MVP); operator-created tmux sessions named `pdx--*` outside pdx's lifecycle (treated as orphans by design).

## Acceptance criteria

- [ ] Startup settlement runs before any new resources are created on `pdx open`
- [ ] tmux orphans matched by `^pdx--` are killed
- [ ] Live-pid pidfile orphans are killed and cleaned up
- [ ] Stale pidfile orphans are cleaned up without a failed kill attempt
- [ ] `pdx open` succeeds cleanly after a previous unclean shutdown

## Blocked by

- Slice 2 (task-002) — orphan cleanup calls `pithos run cleanup`
- Slice 5 (task-005)
