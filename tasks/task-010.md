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

## Implementation primitives

Builds on task-005 §Implementation primitives (Tmux service, FileSystem) and task-002 §Implementation primitives (`pithos run cleanup`).

- **Order:** orphan discovery runs **before** any new resource is created in `pdx open` — before the new daemon, system run, or Pandora.
- **HITL orphans:** `Tmux.lsSessions()` returns all session names; filter by `^pdx--`. For each match: `Tmux.killSession(name)`.
- **AFK orphans:** `FileSystem.readDirectory("<home>/runs/")` for `*.pid` entries. For each:
  - Parse `runId` from filename (`<run-id>.pid`).
  - Read pid via `FileSystem.readFileString` and parse as integer; malformed → fail loud with `VALIDATION_ERROR`.
  - Probe alive: `Effect.try({ try: () => process.kill(pid, 0), catch: () => false })`. ESRCH → dead.
  - Alive: `process.kill(pid, "SIGTERM")` then short wait, retry `SIGKILL` if needed; then `pithos.run.cleanup({ run: runId, reason: "daemon_start" })`; remove pidfile.
  - Dead (stale pidfile): only `pithos.run.cleanup({ run: runId, reason: "daemon_start" })`; remove pidfile. No kill attempt.
- **Pidfile persistence is intentional:** crashed-pdx leaves pidfiles in place so the next `pdx open` finds and reaps them. No "auto-cleanup on process exit" library — that would defeat this path.
- **Idempotency:** running orphan discovery twice in a row is safe. After the first pass clears everything, the second is a no-op.

## Acceptance criteria

- [ ] Startup settlement runs before any new resources are created on `pdx open`
- [ ] tmux orphans matched by `^pdx--` are killed
- [ ] Live-pid pidfile orphans are killed and cleaned up
- [ ] Stale pidfile orphans are cleaned up without a failed kill attempt
- [ ] `pdx open` succeeds cleanly after a previous unclean shutdown

## Blocked by

- Slice 2 (task-002) — orphan cleanup calls `pithos run cleanup`
- Slice 5 (task-005)
