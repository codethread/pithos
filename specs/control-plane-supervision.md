# Control Plane Supervision

**Status:** Implemented
**Last Updated:** 2026-05-17

## 1. Overview

### Purpose

Pandora's Box is a local **Control plane** composed of three layers:

1. **Pithos** — durable state and graph invariants for Tasks, Runs, Claims, Fencing tokens, Artifacts, Events, and Repair Alerts.
2. **Spawner** — Harness launcher that renders Agent prompts, builds Harness argv/env, starts AFK processes or HITL tmux sessions, and parses Harness session logs.
3. **pdx** — local supervisor that reconciles Pithos state with live processes/tmux sessions through an in-memory Registry.

Agents claim work themselves through Pithos. pdx never injects Task content into prompts. Pandora is a long-lived HITL Agent that claims Escalation tasks and talks with the user.

### Goals

- Keep durable truth in Pithos and live resource policy in pdx.
- Keep Spawner launcher-only: prompt rendering, Harness launch, and transcript parsing.
- Start and stop the box through `pdx init`, `pdx open`, and `pdx close`.
- Maintain exactly one Pandora singleton while the box is open.
- Spawn non-Pandora Agents only for claimable work and cap them by Registry entries.
- Finalize Runs only from pdx after observing or confirming live resource death.
- Route broken chains to Pandora with durable Repair Alerts instead of hidden retries.
- Expose operator/Pandora inspection through pdx commands and Supervisor logs.

### Non-Goals

- No distributed or multi-host supervision.
- No persisted Registry; Pithos is durable truth, Registry is live pdx memory.
- No Same-run resurrection. Dead Agents are cleaned up; later reconcile may create a Fresh run.
- No automatic repair of failed/cancelled/dead-lettered Dependencies.
- No generic message injection into Harness sessions; Nudges are content-free signals paired with durable Pithos state.

## 2. Design Decisions

- **Decision:** Split durable state, launch mechanics, and supervision policy across Pithos, Spawner, and pdx.
  - **Rationale:** Each layer has a different source of truth. Mixing them causes lifecycle drift, prompt coupling, and hard-to-debug state races.

- **Decision:** pdx uses `@pdx/pithos` as a typed library, not the `pithos` CLI.
  - **Rationale:** The CLI is an Agent/operator boundary. The supervisor needs typed in-process state transitions without subprocess parsing.

- **Decision:** Spawner does not register Runs or own Kill/Cleanup/Interrupt.
  - **Rationale:** Those operations require Pithos invariants plus live Registry policy, which belong to pdx.

- **Decision:** pdx never pre-claims Tasks.
  - **Rationale:** Spawn and Claim are separate. A launched Agent claims through Pithos; if work disappeared, it sees `NO_CLAIMABLE_WORK` and exits or is cleaned up.

- **Decision:** Cleanup, Interrupt, and Cancel are distinct.
  - **Rationale:** Cleanup is for confirmed natural Run death, Interrupt is for deliberate Kill of a live Run, and Cancel is for abandoning non-held Task work.

- **Decision:** Launch-precondition failures cancel queued work and create a Repair Alert atomically.
  - **Rationale:** A missing repo/worktree cwd means the queued Task cannot launch as written. Marking it failed would imply an Agent attempted it; retrying it would loop.

- **Decision:** Harness/config/process failures are supervisor errors, not Task cancellation.
  - **Rationale:** A missing Harness binary or malformed manifest is operator/configuration failure. User work must not be silently cancelled.

- **Decision:** Nudges are content-free and best-effort.
  - **Rationale:** Durable Pithos Tasks/Artifacts are the source of attention. A Nudge only shortens the time until Pandora checks Pithos.

## 3. Built-in Agents and Capabilities

Pithos seeds and enforces the built-in Agent kinds, Capabilities, claim authorization, and enqueue authorization.

| Agent kind | Mode today   | Claims             | Enqueues                                            |
| ---------- | ------------ | ------------------ | --------------------------------------------------- |
| `pdx`      | system actor | —                  | `escalate`, `intake`                                |
| `pandora`  | HITL         | `escalate`         | `triage`, `design`, `review`, `escalate`            |
| `envy`     | AFK          | `intake`           | `triage`, `design`, `escalate`                      |
| `toil`     | AFK          | `triage`           | `triage`, `design`, `execute`, `review`, `escalate` |
| `greed`    | HITL         | `design`, `review` | `triage`, `design`, `escalate`                      |
| `war`      | AFK          | `execute`          | `escalate`                                          |

Capabilities are `intake`, `triage`, `design`, `execute`, `review`, and `escalate`. `execute` work must be in repo/worktree Scope. `intake` and `escalate` work lives in global Scope. `review` work may be global, repo, or worktree scoped and is ordinary non-escalation work claimed by Greed. Pithos enforces the durable authorization contract; templates describe workflow policy but are not authorization truth.

## 4. pdx Lifecycle

### `pdx init`

`pdx init` prepares the data dir, initializes Pithos, creates runtime directories, materializes bundle-owned `<data-dir>/agents.toml`, `<data-dir>/templates/`, and `<data-dir>/AGENTS.md`, preserves scaffold-once `<user-data-dir>/AGENTS.md`, `<user-data-dir>/CLAUDE.md`, and `<user-data-dir>/agents.toml`, and re-seeds installed `<user-data-dir>/PANDORA.md`. It does not touch tmux or Harness CLIs.

- normal init reuses existing state
- `--clean` removes DB, runs, and logs while preserving bundled config and user config
- `--nuke` removes pdx-owned runtime/bundled state while preserving `<user-data-dir>`
- `--clean` and `--nuke` are mutually exclusive

### `pdx open`

`pdx open` runs init behavior, fails if the `pdx--daemon` tmux session already exists, starts the daemon in tmux, waits for IPC readiness, and attaches the operator to Pandora's tmux session. The daemon settles deterministic old pdx-owned tmux/AFK leftovers, upserts the `pdx` system Run, starts Pandora, and begins reconciliation.

### Reconcile tick

Each tick settles lifecycle before spawning:

1. observe Registry entries
2. Cleanup AFK/HITL resources that are gone
3. handle no-claim timeouts for non-Pandora sessions that never claimed work
4. reap non-Pandora HITL sessions after their first held Task clears
5. continue terminating Kills until resources are gone
6. run event-pruning maintenance once on startup and then at hourly cadence
7. maintain the Pandora singleton
8. send a content-free Nudge when claimable Escalation work appears
9. validate launch cwd for one selected claimable non-Pandora Task
10. spawn at most one Agent through Spawner, in built-in order with Envy before Toil/Greed/War; claimable `design` and `review` work both launch Greed with the selected claim Capability passed to Spawner for deterministic claim-command rendering
11. supervise the configured input hook, if any

Registry entries in `launching`, `live`, and `terminating` states count against caps. The MVP cap is one live entry per `(Agent kind, Scope)` plus the global AFK cap.

### `pdx close`

`pdx close` stops spawning, kills supervised AFK/HITL resources including Pandora, confirms they are gone, calls Pithos Cleanup for in-memory Agent runs, cleans up the `pdx` system Run last, and closes the daemon tmux session.

## 5. Greed Review Lifecycle

Greed handles `review` Tasks as requested HITL assessment: inspect the Task graph and scoped context, prepare the walkthrough, then enqueue a global `escalate` readiness Task so Pandora can route the user to Greed's live session. Greed records the outcome in a `review-report` artifact and completes the review Task; rejected work is routed onward through Pandora/Toil rather than silently rewriting the chain.

## 6. Repair Alerts and Broken Chains

A **Repair Alert** is a system-authored global Escalation task with a typed `kind`. It is durable, claimable by Pandora, and paired with Pithos graph provenance when it names affected work.

Implemented kinds include:

- `interrupt` — pdx deliberately interrupted a live Held task during Kill
- `task_failed` — an Agent failed a Held task
- `dead_letter` — Cleanup exhausted Attempts for a Held task
- `launch_precondition` — queued work could not launch because its repo/worktree cwd was missing or invalid
- `reconciler_stuck` — repeated reconcile failures need Pandora/operator attention
- `kill_failure` — pdx could not kill a live resource after repeated attempts
- `input_hook_stuck` — the configured input hook crash-looped
- `hook_config_error` — input hook configuration/rendering failed

Repair Alerts that reference one affected Task carry a `repair_source` Source link. They do not depend on the affected Task because failed, cancelled, and dead-lettered Tasks do not satisfy Dependencies. Pandora repairs the Broken chain with Supersession, explicit replanning, or intentional Cancel.

Task-failure, dead-letter, and interrupt Repair Alerts are created by Pithos in the relevant Task/Run transition. pdx owns invoking Interrupt before killing the live resource, but Pithos owns the durable Alert side effect transactionally. Launch-precondition Repair Alerts are created by a Pithos atomic transition that cancels the still-queued Task, records repair provenance, creates the Escalation task, and emits Events in one transaction.

## 7. Kill, Cleanup, Timeout, and Launch Abort

### Cleanup

pdx calls Pithos Cleanup only after it confirms the execution resource is gone. Cleanup terminalizes the Run and, if a Held task was still active, requeues or dead-letters that Task based on Attempts/max Attempts while incrementing its Fencing token.

### Interrupt / Kill

`pdx run kill` and `pdx task kill` mutate Pithos first with Interrupt, then kill the OS process or tmux session. If a Held task was interrupted, the Pithos Interrupt transition creates an `interrupt` Repair Alert. Killing is retried on reconcile while the Registry entry remains `terminating`; repeated kill failures create a `kill_failure` Repair Alert.

### Timeout

A non-Pandora no-claim session that exceeds the bootstrap timeout is killed, confirmed gone, and terminalized as a Timed out run. No Task is mutated. This decision uses durable Run state (`runs.has_claimed_task`) rather than scanning retained `task.claimed` events.

### Event pruning maintenance

pdx invokes Pithos event pruning through the typed library boundary, not by shelling out to the `pithos` CLI.

Retention semantics:

- prune `run.heartbeat` and `task.heartbeat` events when `created_at < now - 1 day`
- prune all other event types when `created_at < now - 7 days`
- use strict older-than cutoffs so exact boundary timestamps are retained until the next eligible tick

Scheduling semantics:

- run once on the initial daemon reconcile tick after startup/open
- run again only when at least one hour has elapsed since the last successful prune in daemon memory
- log completion under Supervisor span `pdx.maintenance` with deleted counts, `last_prune_at`, and `next_due_at`

Pruning is maintenance, not invariant storage: Pithos' Run timeout/launch-abort safety must remain correct even if older `task.claimed` events have been deleted.

### Launch abort

If pdx creates a Run row but the launch cannot complete before the Agent claims work, pdx uses the Pithos launch-abort transition. The no-claim Run becomes `cancelled`, no Task is mutated by that Run transition, and launch-precondition task repair runs separately only when the original queued Task still matches expected preconditions.

## 8. Spawner Boundary

pdx renders before it launches:

```text
pdx reconcile
  -> Spawner.renderAgent(input)
  -> Pithos run upsert with rendered mode, Harness kind, and session log path
  -> Spawner.launchRenderedAgent(rendered)
  -> pdx stores runtime pid/tmux metadata in Registry
```

Spawner owns:

- manifest and template validation
- command-card rendering into prompts
- Harness argv/env construction
- expected Harness session log paths
- AFK process launch and HITL tmux launch
- Harness session transcript parsing for `pdx run transcript`

Spawner does not own Pithos graph policy, live Registry state, Kill, Cleanup, Interrupt, Cancel, or Nudge policy.

## 9. Input Hook

Layered `agents.toml` may configure `hooks.input.command` through the global config layers. pdx runs that command as a producer process after Pandora is live. The hook writes newline-delimited JSON on stdout; each valid line with non-empty `title` and `body` creates a global `intake` Task for Envy. Invalid lines are logged and skipped.

pdx supervises the hook independently:

- stdin is closed
- stderr goes to `<data-dir>/runs/hook.stderr.log`
- stdout is bounded and parsed as NDJSON
- exits restart with exponential backoff capped at 30 seconds
- backoff resets after stable uptime
- repeated crashes create an `input_hook_stuck` Repair Alert and stop restarting until pdx is restarted
- `pdx close` sends SIGTERM

## 10. Operator and Pandora Interfaces

The public `pdx` surface is the operator/Pandora control surface:

- `pdx init`, `pdx open`, `pdx close`
- `pdx daemon status`, `pdx daemon logs`
- `pdx run kill`, `pdx run transcript`, `pdx run show`
- `pdx task kill`, `pdx task show`

All commands resolve data dir as `--data-dir`, then `PDX_DATA_DIR`, then `$HOME/.pdx`.

`pdx daemon logs` reads structured Supervisor log JSONL even after the daemon stops. These are Supervisor logs, not Harness transcripts. `pdx run transcript` reads the Pithos Run transcript metadata and delegates Harness-log parsing to Spawner. System Runs fail loudly for transcript rendering and point to Supervisor logs.

## 11. Code Locations and Tests

- `packages/pdx/src/controller.ts` — lifecycle, reconcile, Kill, launch-precondition handling, input hook supervision
- `packages/pdx/src/live.ts` — live service bindings, Pithos/Spawner integration, template materialization
- `packages/pdx/src/main.ts` — public CLI and IPC dispatch
- `packages/pdx/src/services.ts` — injected services and Registry interface
- `packages/pdx/src/log.ts` — Supervisor log JSONL
- `packages/pithos/src/engine.ts` and `packages/pithos/src/engine/*` — Run/Task transitions, Repair Alert creation, Task/Scope read models, graph inspection, Engine output contracts, and text renderers
- `packages/spawner/src/spawner.ts` — render/launch/transcript behavior
- `resources/README.md` — manifest, layered template/config contract, input hook contract

Automated coverage lives primarily in `packages/pdx/test/substrate.test.ts`, `packages/pithos/test/`, and `packages/spawner/src/spawner.test.ts`.
