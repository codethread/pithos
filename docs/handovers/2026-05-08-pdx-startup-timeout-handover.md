# pdx startup timeout handover

Date: 2026-05-08
Branch: `daemon-10`
Code fix commit: `8ad8452` (`fix(pdx): harden daemon startup recovery`)

## Executive summary

The recurring `pdx open` startup timeout turned out to be two overlapping problems:

1. **A real startup reliability problem** in `pdx` startup sequencing and recovery.
2. **A diagnostics problem** where several distinct daemon-start failure modes were collapsed into the same generic message:
   - `Timed out waiting for daemon readiness ...`

The branch is now in a much better state:

- `pnpm verify` passes.
- `pdx open` startup failures surface actionable diagnostics instead of a blind timeout.
- failed startup attempts clean up their own debris instead of poisoning the next `pdx open`
- orphan discovery now cleans up durable built-in runs as well as tmux/pidfile resources
- the fixed `run_pdx_system` row reopens cleanly across close/open cycles, including home changes
- AFK liveness probing no longer silently treats all probe failures as "dead"
- competing `pdx open` calls are serialized with a lock

## Original symptom

The operator-visible symptom was:

```json
{"ok":false,"error":{"code":"USER_ERROR","message":"Timed out waiting for daemon readiness at <home>/pdx.sock"}}
```

This was seen both in real use and under investigation repros.

## Root cause analysis

### 1. `pdx open` waited on a narrow readiness signal with a short wall-clock budget

`pdx open` waited for daemon readiness using a fixed timeout and polling loop. Before the fix, the daemon did substantial startup work before the socket was even reliably serving status, including Pandora startup work.

That meant a startup could be **healthy but slow**, and `pdx open` would still conclude it had failed.

### 2. daemon-side startup failures before readiness were masked as timeouts

If the daemon process died before the readiness socket became useful, `pdx open` had almost no structured information to work with. Different failure causes all looked the same from the outside:

- pithos subprocess failure during daemon startup
- pandora-spawn preview failure
- tmux/pane startup failure
- socket not yet available

The opener just kept polling until the timeout expired.

### 3. failed startups could leave stale execution resources behind

When startup failed mid-flight, there were paths where:

- `pdx--daemon` could remain behind
- built-in runs could remain active in Pithos
- the next `pdx open` would trip over leftover state

That made the problem sticky: a transient failure could create a persistent manual-recovery situation.

### 4. orphan cleanup was incomplete on the durable-state side

Slice 10 originally cleaned:

- `^pdx--` tmux sessions
- AFK pidfiles under `<home>/runs/*.pid`

But durable cleanup was only guaranteed for runs directly discoverable from pidfiles. That left a gap for built-in HITL/system rows that were active in Pithos even after execution resources were gone.

### 5. the fixed pdx system run id collided with immutable run fields

`run_pdx_system` is a fixed id. Pithos run upsert historically treated run identity fields as immutable, including `cwd`.

So after a close/open cycle with a different `--home`, daemon startup could fail because the existing terminal `run_pdx_system` row still carried the old home-derived cwd.

### 6. AFK liveness probing swallowed the wrong errors

There was a helper that effectively treated **any** `process.kill(pid, 0)` exception as "process is dead".

That is unsafe. Only `ESRCH` should mean dead. Anything else should fail loudly, otherwise a live AFK worker can be misclassified and reclaimed incorrectly.

### 7. concurrent `pdx open` needed serialization

Because the daemon tmux target is singleton/global (`pdx--daemon`), overlapping `pdx open` calls needed an explicit startup gate. Without that, one opener could interfere with another opener's startup/cleanup behavior.

## What I tried during investigation

### First investigation pass

I isolated the issue without fixing it.

I reproduced the generic timeout symptom deterministically by making daemon-side `pithos run upsert` fail after parent-side `pdx open` had already begun startup.

That proved an important point:

> the timeout was not just "the daemon is slow"; it was also hiding real daemon-start failures.

### Rebase onto slice 6

I rebased the slice-10 work onto `daemon` (slice 6 work from another agent).

That changed the startup contract significantly because `pdx open` now waits for Pandora, not just a daemon socket.

After the rebase, some of the original flaky timeout behavior stopped reproducing organically, but the masked-startup-failure problem still existed.

### Iterative hardening work

I then made a sequence of changes, reran tests, reran `pnpm verify`, and repeatedly stress-tested the path.

Notable iterations included:

1. adding startup diagnostics from supervisor log + daemon pane capture
2. preserving then reading daemon tmux pane output on failed startup
3. cleaning startup debris on failure instead of leaving stale sessions/runs behind
4. cleaning active built-in runs durably via Pithos rather than only via pidfile-derived ids
5. reopening the terminal pdx system run instead of leaving it terminal forever
6. moving daemon socket availability earlier in startup sequencing
7. adding startup token ownership so `pdx open` can distinguish its own daemon startup from another one
8. adding a lock so concurrent opens do not race on the singleton daemon target
9. tightening readiness so `pdx open` only returns when Pandora should actually be attachable

## Final code changes

## `packages/pdx/src/commands/open.ts`

### Added better startup diagnostics

`pdx open` now enriches startup failures with:

- recent supervisor log lines
- recent daemon state file contents when available
- tmux pane capture for `pdx--daemon`

This turns the old blind timeout into a useful failure message.

### Added startup cleanup on failed open attempts

If `pdx open` launches a daemon attempt and readiness fails, it now performs startup cleanup rather than leaving the next open attempt to trip over stale state.

### Added startup token ownership

A unique startup token is passed into each daemon start attempt. The opener waits for readiness from the daemon instance that matches its own token.

This prevents one opener from mistaking a different daemon instance for its own startup attempt.

### Added open serialization lock

A `pdx open` lock is now acquired before startup work proceeds.

This prevents overlapping opens from fighting over the singleton daemon tmux target.

### Improved readiness semantics

`pdx open` now waits for a stronger readiness condition:

- matching startup token
- daemon `phase === "ready"`
- Pandora registry entry is `live`

This is stronger than the earlier "socket answered something" contract.

### Orphan cleanup now includes active built-in runs

Startup settlement still kills deterministic execution leftovers, but it now also cleans **active built-in runs** through Pithos so durable state matches execution reality.

## `packages/pdx/src/daemon.ts`

### Socket comes up earlier in startup

The daemon now starts serving status earlier in startup instead of doing all expensive startup work before the socket becomes useful.

This significantly reduces false timeout risk.

### Added daemon startup phase

The daemon state now carries:

- `startupToken`
- `phase: "starting" | "ready"`

This gives the opener and future debugging code a more faithful view of startup progress.

### Startup failures now clean up the pdx system run

If daemon startup fails after the system run has been upserted, the system run is cleaned up instead of being left active/poisoned.

### AFK liveness now uses injected process service

Reconcile no longer uses a helper that swallowed all probe failures. It now uses the injected `ProcessService.probePid`, which only treats `ESRCH` as dead and fails loudly otherwise.

## `packages/pdx/src/services/tmux.ts` / `packages/pdx/src/layers/tmux.ts`

Added tmux primitives needed for reliable startup diagnostics and control:

- `paneDead`
- `capturePane`
- `setRemainOnExit`
- `remainOnExit` support on `newSession`

## `packages/pdx/src/services/pithos.ts` / `packages/pdx/src/layers/pithos.ts`

Added:

- `listActiveBuiltInRuns()`

so `pdx` can reconcile durable built-in runs during startup settlement.

## `packages/pithos/src/commands/run.ts`

### Added `run active-builtins`

A new internal command returns nonterminal built-in runs.

This gives `pdx` a durable-source-of-truth way to clean startup leftovers.

### Reopen behavior for terminal pdx system run

Terminal `pdx` system runs can now be reopened into `starting`, with home-derived fields (`cwd`, `session_id`) refreshed appropriately.

This fixes reopen across close/open cycles and home changes.

## `packages/pdx` / `packages/pithos` tests

Added and expanded tests covering:

- daemon startup failure diagnostics
- no stale daemon tmux session after failed startup
- system run reopen behavior
- stale daemon reopen behavior
- startup ordering
- process probe non-`ESRCH` failures
- pithos terminal pdx run reopen with refreshed cwd

## Validation performed

I repeatedly ran:

```sh
pnpm verify
```

Final state:

- lint: green
- typecheck: green
- test: green
- build: green

At the end of this session:

- `46` test files passed
- `464` tests passed

## Remaining recommendations

These are not blockers for moving forward, but they are worth keeping in mind.

### 1. Consider promoting startup timeout to an explicit CLI option

The opener now uses a larger readiness timeout via:

- `PDX_OPEN_READY_TIMEOUT_MS` override
- default `20000`

That is much safer than 5 seconds, but a first-class CLI flag could make operator control clearer.

### 2. Consider richer daemon ownership metadata if multi-home support becomes important

The system still has a global tmux daemon singleton (`pdx--daemon`) while also supporting `--home`.

This session hardened the current behavior, but if you want true multi-home coexistence later, the architecture likely needs one of:

- global single-home enforcement everywhere, or
- namespaced daemon/session/socket/state resources per home

### 3. Consider making startup readiness an explicit daemon-side deferred/transition

Right now readiness is still determined by polling daemon status state. This is far better than before, but a dedicated daemon-side ready signal/deferred would be even cleaner.

### 4. Consider dedicated tests for lock staleness / operator interruption during open

The open lock now prevents competing opens. A future follow-up could add direct tests for:

- stale lockfile recovery
- opener interruption while lock is held
- behavior when another operator/process is already opening

## Suggested next session starting points

If you pick this up later, likely next good steps are:

1. continue with the next slice work on top of commit `8ad8452`
2. if startup flakiness reappears on another machine, capture:
   - daemon pane
   - `pdx.jsonl`
   - `pdx-state.json`
   - `pithos-next run active-builtins`
3. if `--home` behavior becomes a real operator workflow, revisit whether the daemon singleton should stay global

## Current expected state

After this fix set:

- `pdx open` should either:
  - succeed and print `tmux attach -t pdx--pandora`, or
  - fail with actionable startup diagnostics
- failed startup attempts should not leave stale daemon/Pandora/system-run debris behind
- AFK liveness should no longer silently misclassify unexpected probe errors as death

