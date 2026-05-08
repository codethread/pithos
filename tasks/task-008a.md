# Slice 8a — Spawn policy for Toil/Greed/War

## What to build

Extend the pdx reconcile loop from task 006 to spawn non-Pandora agents when Pithos reports claimable work.

After lifecycle settlement and Pandora singleton maintenance, each reconcile tick:

1. Inspect claimable tasks from Pithos.
2. Iterate seeded spawn order: `toil`, `greed`, `war`.
3. For the first eligible agent kind with claimable work, derive the run scope/cwd and launch via `spawnerLib.launchAgent`.
4. Upsert a fresh Pithos run before launch with caller-supplied `runId`, `sessionId`, `agent`, `mode`, `scope`, and `cwd`.
5. Add a Registry entry with state `launching`, then mark `live` once launch metadata is available.
6. Spawn at most one non-Pandora agent per tick.

Rules:

- pdx never pre-claims tasks. Spawned agents claim via their rendered `claim_command`.
- If the task is taken before the spawned agent claims, the agent receives Pithos `NO_CLAIMABLE_WORK` and exits/finishes normally.
- Scope cwd derivation:
  - `repo` / `worktree` scopes use `scope.canonical_path`
  - `global` uses `<pdx home>` for global `triage`/`design` work; `war` cannot spawn for global `execute` because Pithos rejects global `execute` tasks
- New spawn uses a fresh run id and session id; no same-run resurrection.

## Test focus

- Spawn order: when multiple eligible kinds exist, `toil` wins before `greed`, and `greed` before `war`.
- One spawn per tick.
- pdx does not pre-claim; Pithos task remains queued until the agent claims.
- Fresh run/session IDs per spawn.
- cwd derivation for global/repo/worktree scopes.
- Spawner called with expected `agent`, `mode`, `runId`, `sessionId`, `scopeId`, and `cwd`.

## Defer

- Cap enforcement; task 008b.
- AFK pidfiles; task 008c.
- No-claim timeout; task 008d.
- Startup orphan discovery; task 010.

## Acceptance criteria

- [ ] Reconcile can spawn `toil`, `greed`, and `war` from claimable queue state
- [ ] No pre-claiming occurs
- [ ] At most one spawn per tick
- [ ] Seeded spawn order and cwd derivation are tested
