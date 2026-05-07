# Slice 8 — Agent spawning: caps, no-claim timeout, pidfiles

## What to build

Extend the reconcile loop in `packages/pdx/` to spawn Toil/Greed/War on demand and enforce caps + no-claim timeout. Pandora and the pdx system run are excluded throughout.

Reconcile spawn step (after lifecycle settlement, after Pandora singleton check):

- Inspect claimable tasks per spec §4.
- Iterate spawnable agent kinds in seeded order: `toil`, `greed`, `war`.
- For each kind: if there is a claimable task its capability authorizes, and its cap is not full, spawn it via `spawnerLib.launchAgent` with the right scope and cwd.
- Spawn at most one agent per tick.
- pdx never pre-claims. The spawned agent claims via Pithos. If the task was taken by another agent before the new one claims, the agent receives `NO_CLAIMABLE_WORK` and exits cleanly.

Caps:

- Per `(agent_kind, scope_id)`: max 1 live entry for spawnable agents (excludes Pandora and pdx).
- Global `--max-afk` cap counted from registry AFK entries.
- Caps count `launching`, `live`, and `terminating` entries.

cwd derivation:

- `repo` / `worktree` scopes → `scope.canonical_path`
- `global` scope → `<pdx home>` (Pandora and pdx system run only)

AFK pidfile lifecycle:

- On AFK launch, write `<home>/runs/<run-id>.pid` containing the pid.
- On `run cleanup` for that run, remove the pidfile.
- Used by orphan discovery in slice 10.

No-claim timeout:

- Hardcoded 30 seconds. Excludes Pandora and the pdx system run.
- A registry bootstrap rule: applies only to spawnable entries that have **never** held a task. Once a run has ever held a task, later idle/null `runs.task_id` periods are not no-claim sessions.
- When breached: kill the registered process / tmux session, confirm gone, then `pithos run timeout` for the run.

## Test focus

Mock the harness via the existing DI seam so tests do not require Anthropic credentials or real `claude`/`pi` binaries.

- Spawn order respected (`toil`, `greed`, `war`) — given multiple eligible kinds, the seeded-order one wins
- One spawn per tick — given multiple eligible kinds, only one launches per tick
- Cap counting includes `launching`, `live`, `terminating` entries
- Pandora and pdx system run excluded from per-(agent, scope) cap accounting
- No-claim timeout fires at 30s for a never-claimed spawnable entry
- No-claim timeout never fires for Pandora; never for pdx system run
- No-claim timeout does not fire for an entry that previously held a task and is now idle
- AFK pidfile written at launch and removed at cleanup
- cwd selection: global → `<pdx home>`; repo/worktree → `scope.canonical_path`

Defer: spawn-policy fairness across many scopes; cap configurability under load; pidfile race-with-restart edges (slice 10 covers stale pidfiles on startup).

## Implementation primitives

Builds on task-006 §Implementation primitives (registry, reconcile, Schedule).

- **Per-(agent, scope) caps:** lazily created `` Map<`${agentKind}:${scopeId}`, Semaphore> ``; each `Semaphore(1)`. Spawn block runs under `withPermits(1)`. Permit released only when the registry entry is removed (post-kill or natural death). Pandora and pdx system run excluded by checking `agentKind` before consulting the cap map.
- **Global `--max-afk` cap:** `Semaphore(maxAfk)` permit held only for AFK entries. Released on registry-entry removal.
- **Spawn order per tick:** iterate seeded order `["toil", "greed", "war"]`; first eligible kind whose cap allows wins. At most one spawn per tick. Seeded order is a config constant, not a DB query.
- **No-claim 30s timeout:** registry entry carries `launchedAt: Date` and `everClaimed: boolean`. Each reconcile tick, for each entry where `agentKind ∉ {pandora, pdx}` and `everClaimed === false` and `now - launchedAt >= 30_000ms`: kill the resource (Tmux/Process), confirm gone, then `pithos.run.timeout({ run: runId, reason: "no_claim_timeout" })`. Once `everClaimed` flips true (observed when `runs.task_id` first becomes non-null at any tick), it stays true permanently — later idle/null `task_id` periods are not no-claim sessions per spec §4.
- **AFK pidfile lifecycle:** at launch, atomic write via tmp+rename — `FileSystem.writeFileString("<home>/runs/<run-id>.pid.tmp", String(pid))` then `FileSystem.rename(tmp, final)`. Survives crash by design (orphan discovery in task-010 reaps stale ones). On `pithos.run.cleanup`, remove the pidfile. **Do not** auto-cleanup on process exit — that defeats orphan detection.
- **cwd derivation:** function over scope kind. `repo` / `worktree` → `scope.canonical_path` (must be non-null per task-001 capability scope rules); `global` → `<pdx home>` (Pandora and pdx system run only).

## Acceptance criteria

- [ ] Reconcile spawns `toil`, `greed`, `war` when claimable + cap allows
- [ ] One spawn per tick, seeded order
- [ ] Per-(agent, scope) cap and `--max-afk` cap enforced and tested
- [ ] No-claim timeout transitions non-Pandora idle spawnable entries to `timed_out`; Pandora and pdx excluded
- [ ] AFK pidfile lifecycle correct
- [ ] cwd derivation correct per scope kind

## Blocked by

- Slice 2 (task-002)
- Slice 6 (task-006)
