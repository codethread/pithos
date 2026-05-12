# Slice 6 — Pandora singleton + death detection + DEMO GATE 2

## What to build

Stand up the reconcile loop in `packages/pdx/` enough to maintain the Pandora singleton and observe natural death. No spawning of Toil/Greed/War yet (that arrives in slice 8).

Reconcile loop tick (default 5s; configurable via `--interval-seconds`):

1. Observe in-memory registry entries.
2. Probe deaths:
   - HITL: `tmux has-session -t <target>`
   - AFK: process handle / `kill(pid, 0)`
3. On death of an entry: `pithos run cleanup` (which handles task requeue/dead-letter for any held task), then remove the registry entry.
4. (Skipped this slice: Toil/Greed/War spawning, no-claim timeout — slice 8.)
5. Heartbeat live HITL entries via `pithos task heartbeat --run <id>` (liveness only; Pandora normally has no held task).
6. Maintain Pandora singleton: if no live Pandora registry entry, spawn fresh one via `spawnerLib.launchAgent` with `agent=pandora`, `mode=hitl`, `scope=global`, `cwd=<home>`. New `runId` and `sessionId` per spawn — no same-run resurrection.

Registry entry shape (minimum): `runId`, `agentKind`, `mode`, `scopeId`, `state` (`launching | live | terminating`), `logicalName`, `pid` (AFK only), `tmuxTarget` (HITL only — Pandora always `pdx--pandora`).

`pdx open` prints `tmux attach -t pdx--pandora` on success and exits. The Pandora session must be alive (or imminently launching) before `pdx open` returns.

`pdx close` now also kills Pandora's tmux session before tearing down the system run, in line with spec §4.

## Demo gate

Second demo gate. the user + an agent walk through:

1. `pdx open` succeeds, prints attach command, daemon JSON log started.
2. the user runs `tmux attach -t pdx--pandora`, sees Pandora alive in a fresh harness session.
3. Pandora can use `pithos` CLI from inside her session — e.g. `pithos task enqueue --capability triage ...` (the task sits queued; nothing claims it yet because slice 8 spawning isn't in).
4. `pdx status --json` accurately reflects daemon up + Pandora registry entry + queue counts at each step.
5. the user runs `tmux kill-session -t pdx--pandora`. Within ~5s reconcile observes death, calls `run cleanup`, then spawns a fresh Pandora with a new run id. the user re-attaches and confirms.
6. `pdx close` cleans up Pandora's session, then the daemon, then the pdx system run.

Commit a replayable demo script (e.g. `docs/demos/pdx-pandora.md`).

## Test focus

- Pandora singleton invariant: registry never holds two live Pandora entries
- HITL death probe correctness: tmux-session disappearance triggers cleanup + respawn within one tick
- AFK death probe (`kill(pid, 0)`) unit-tested in isolation against a known live and known dead pid (slice 8 uses it for real)
- Fresh `runId` per respawn — no row reuse, no same-run resurrection
- `pdx open` does not return until Pandora is launching/live
- `pdx close` order: Pandora killed → daemon stopped → pdx system run cleaned up last

Defer: tmux integration robustness beyond happy path; reconcile-tick scheduling stress.

## Implementation primitives

`Tmux` service from task-005a. Reconcile/registry primitives are canonical here, referenced by 007/008/009.

- **Registry:** `SynchronizedRef<Registry>`. `SynchronizedRef.modifyEffect` snapshots state and returns decisions atomically; **side effects (spawn, kill, log) happen outside the lock**, after `modifyEffect` returns. Holding the ref across IO would serialise the daemon.
- **Registry entry tag:** `state: "launching" | "live" | "terminating"` is a discriminator, not a string flag. Caps count all three.
- **Reconcile loop:** `Effect.repeat(reconcileTick, Schedule.spaced("5 seconds"))`. `Schedule.spaced` (not `fixed`) — measures between completions, so a 7s tick cleanly sleeps 5s after; `fixed` would catch up with rapid back-to-back ticks. `--interval-seconds` builds the schedule from a parsed `Duration`.
- **Per-agent observer fibers:** `FiberMap<runId>`. `FiberMap.run(observers, runId, observeAgent(runId), { onlyIfMissing: true })` prevents duplicate observers. `forkScoped` (FiberMap default) so `pdx close` interrupts deterministically.
- **Pandora singleton invariant:** `Effect.makeSemaphore(1)` permit held for the duration of a Pandora registry slot. Reconcile tries `withPermits(1)` to spawn; if taken, no spawn.
- **AFK liveness probe:** `Effect.try({ try: () => process.kill(pid, 0), catch: () => false })`. ESRCH → false. Wrap in the `Process` service so tests can inject.
- **HITL liveness probe:** `Tmux.hasSession(target)` from task-005a.
- **Fresh runId per respawn:** `Ids` service generates new id; no row reuse, no same-run resurrection.
- **`pdx open` waits for Pandora launch:** open handler suspends on a `Deferred<void>` that the first reconcile tick resolves once a Pandora entry hits `launching` or `live`.

## Acceptance criteria

- [ ] Reconcile loop runs at default 5s tick; `--interval-seconds` honored
- [ ] Pandora singleton invariant maintained
- [ ] HITL `tmux has-session` death probe; AFK `kill(pid,0)` probe; both unit-tested
- [ ] Death of Pandora's tmux triggers `run cleanup` and a fresh respawn next tick
- [ ] `pdx open` prints `tmux attach -t pdx--pandora` on success
- [ ] `pdx close` tears down in spec §4 order
- [ ] Demo script committed and the user + agent successfully walk through (human-verified, not CI-checkable; record confirmation as a comment on this issue)
