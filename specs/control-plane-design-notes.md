# Control Plane Design Notes

**Status:** Discussion notes
**Last Updated:** 2026-05-07

Informal working notes for the control-plane rewrite. This is not the final spec; it is a shared reference for the design discussion.

## Direction

Three layers:

1. **Pithos** — durable state and invariants.
   - Owns tasks, runs, claims, fencing, artifacts, events, graph.
   - Enforces known agents/capabilities and task state transitions.
   - Does not own OS processes, tmux, or harness supervision.

2. **Spawner** — harness launcher.
   - Owns templates, prompt rendering, harness argv/env, AFK foreground launch, HITL tmux launch.
   - Returns launch metadata: pid, tmux target, session id/log path, harness kind.
   - Does not register runs, reclaim, kill, nudge, inspect status, or make lifecycle decisions.
   - May keep a dev/internal CLI for previewing rendered templates.

3. **pdx** — local supervisor/control plane.
   - Owns reconcile loop, registry, caps, lifecycle policy, process/tmux ownership.
   - Uses spawner as a launcher library/module, not as an operator API.
   - Exposes Pandora/operator introspection and immediate kill.

## Agent roster and capabilities

Built-in pre-v1 roster:

| Agent     | Mode source | Claims     |
| --------- | ----------- | ---------- |
| `pdx`     | system      | —          |
| `pandora` | manifest    | `escalate` |
| `toil`    | manifest    | `triage`   |
| `greed`   | manifest    | `design`   |
| `war`     | manifest    | `execute`  |

`pdx` is a system actor only: it is not spawnable, has no template, no claims, and may enqueue global `escalate` tasks for supervisor-authored interruptions. `pdx open` upserts its global system run; `pdx close` cleans that run up last.

Pithos seeds and enforces known agents/capabilities at `pithos init` time. Changes before v1 can be clean-break DB resets / migration edits rather than runtime reconciliation.

`pithos task claim` also enforces two run invariants:

- the run may hold at most one active task (`runs.task_id` must be null before claim)
- the requested claim scope must match the run's registered scope

Allowed task capabilities:

- `triage`
- `design`
- `execute`
- `escalate`

All `escalate` tasks live in global scope. Pandora's run is global-scoped, and strict claim scope matching remains unchanged.

`pithos task claim` checks that the run's agent is allowed to claim the requested capability. `pithos task enqueue` checks that the run's agent is allowed to enqueue the requested capability. Mutating task commands resolve `--run` from `PITHOS_RUN_ID` when omitted and fail loudly if both are present but differ.

## Escalation model

`escalate` is a normal queued task capability consumed by Pandora.

Use cases:

- review a design artifact with Adam
- review a completed PR/MR or execution result
- investigate an interrupted/off-rails run
- decide whether to supersede/cancel/replan a broken chain

Planned checkpoint escalations may depend on successful tasks:

```text
triage -> design -> escalate(review design) -> triage(plan execution) -> execute... -> escalate(review result)
```

Failure/interruption escalations must **not** depend on failed/cancelled tasks, because only `done` satisfies dependencies. They are global `escalate` tasks and should reference the failed task/run/scope in body/metadata instead.

Dependencies mean "must successfully complete first". Only `done` satisfies them.

## Repair model

If a task in a chain fails, the chain is repaired with `supersede`, not by treating failure/cancel as dependency satisfaction.

Example:

```text
task1 done -> task2 failed -> task3 queued
```

Pandora/Toil can supersede `task2`:

```text
task1 done -> task2 failed
              ^ superseded by
            task2b queued -> task3 queued
```

Queued direct dependents are rewired to the replacement. Cancelled direct dependents are ignored. Any other non-queued dependent forces explicit replan.

## Minimal CLI surface

Clean-break nested command shape.

```text
pithos init [--fresh]

pithos scope upsert --kind <global|repo|worktree> [--path <path>]

pithos run upsert \
  --agent <pdx|pandora|toil|greed|war> \
  --mode <afk|hitl> \
  --scope <scope-id> \
  --cwd <path> \
  --session-id <session-id> \
  [--run <run-id>]

pithos run cleanup \
  --run <run-id> \
  --reason <text>

pithos run interrupt \
  (--run <run-id> | --task <task-id>) \
  --reason <text>

pithos run timeout \
  --run <run-id> \
  --reason <text>

pithos run inspect <run-id>

pithos task enqueue \
  --scope <scope-id> \
  --capability <triage|design|execute|escalate> \
  --title <text> \
  (--body <text> | --body-file <path>) \
  [--run <run-id>] \
  [--depends-on <task-id> ...]

# --run defaults from PITHOS_RUN_ID for mutating task commands; manual enqueue without a run is not exposed.

pithos task claim \
  --run <run-id> \
  --scope <scope-id> \
  --capability <triage|design|execute|escalate>

# --scope must match the run's registered scope; the run must not already hold a task.

pithos task heartbeat \
  --run <run-id> \
  [--task <task-id> --token <n>]

# Heartbeat records liveness/observability. With --task and --token, it may advance that held task from claimed to running. No hook names, lease extension, or CLI throttling exist in MVP.

pithos task complete \
  <task-id> \
  --run <run-id> \
  --token <n> \
  [--result-file <path>]

pithos task fail \
  <task-id> \
  --run <run-id> \
  --token <n> \
  --reason <text>

pithos task supersede \
  <task-id> \
  --run <run-id> \
  --reason <text> \
  [--title <text>] \
  [(--body <text> | --body-file <path>)] \
  [--scope <scope-id>] \
  [--capability <triage|design|execute|escalate>]

pithos task cancel \
  <task-id> \
  --run <run-id> \
  --reason <text>

pithos task inspect <task-id>

pithos task artifact add \
  --task <task-id> \
  --run <run-id> \
  --kind <kind> \
  --title <text> \
  [--body-file <path>]

pithos graph inspect \
  (--task <task-id> | --scope <scope-id> | --all) \
  [--flat] \
  [--dump]

pithos events tail [--limit <n>]

pithos briefing [--agent pandora]
```

Removed / not exposed:

```text
pithos sweep
pithos run end
top-level enqueue/claim/heartbeat/complete/fail/supersede/tail/artifact/inspect
```

## pdx surface

Minimal operator/Pandora-facing API:

```text
pdx open
pdx close
pdx status
pdx kill (--run <run-id> | --task <task-id>) --reason <text>
pdx logs show [--limit <n> | --all] [--since <when>]
```

No restart command initially. Recovery is explicit: kill interrupts and escalates; Pandora/Adam decide whether to supersede, cancel, or replan. Normal death may still result in a fresh run after cleanup when reconcile sees claimable work. There is no same-run resurrection.

Each pdx reconcile tick settles lifecycle before spawning: observe registry, cleanup entries whose execution is already gone, finish terminating kills, remove settled entries, write pdx-paced heartbeat for live HITL entries when due, then inspect claimable work and spawn. This preserves the invariant that old execution is gone before its work becomes claimable to a fresh run.

`pdx` never pre-claims. It spawns because work is claimable; the agent claims through Pithos. A launched-but-not-claimed live agent still occupies its `(agent, scope)` cap slot. No-claim timeout is a registry bootstrap rule: it applies only to non-Pandora entries that have never observed an initial claim, not to any later idle period after a run completed a held task.

Default reconcile interval is 5 seconds. Each tick settles lifecycle first, then spawns at most one agent in seeded order (`pandora`, `toil`, `greed`, `war`). HITL death detection uses `tmux has-session`; AFK death detection uses the process handle / `kill(pid, 0)`. HITL startup orphans are `^pdx--` tmux sessions; AFK startup orphans are pidfiles under `<home>/runs/`. On successful `pdx open`, the CLI prints `tmux attach -t pdx--pandora` and exits; it does not auto-attach.

`pdx kill` must be immediate and scheduler-visible:

1. Mutate Pithos first with `pithos run interrupt`.
2. If `--task` is supplied and no run holds it, reject and point to `pithos task cancel`.
3. If a held task existed, use the `pdx` system run to enqueue a global `escalate` task for Pandora referencing the interrupted task/run/scope.
4. Mark registry entry `terminating`.
5. Kill OS process / tmux immediately.
6. Retry kill once per reconcile tick, structured-log failures, no max retry in MVP.
7. Remove registry entry after kill succeeds.

`pdx logs show` prints raw structured JSONL supervisor log lines. Default limit is 100. `--since` accepts ISO timestamps, durations like `10m`, `1h`, `2d`, `1w`, plus local-time `today` and `yesterday`. Each supervisor log line includes at least `ts`, `level`, `span`, and `msg`.

Wakeups use `tmux send-keys` to `pdx--pandora` with the content-free marker `# wakeup: claimable escalate`.

## Spawner surface

Spawner may expose dev/internal helpers, especially preview:

```text
pandora-spawn preview --agent <name> --mode <afk|hitl> --scope <scope-id> --run <run-id> --session-id <session-id> --cwd <path>
```

Library shape:

- `renderAgent(input): RenderedAgent` for preview/tests
- `launchAgent(input): LaunchResult` for pdx

Input includes `agent`, required `mode`, `runId`, `sessionId`, `scopeId`, and `cwd`. `run_id` and `session_id` are supplied by pdx. Agent mode is manifest-declared; pdx passes the manifest mode and Spawner validates it against the manifest. Templates get self-claim context and a generated `claim_command`, never task body content.

It should not expose:

- status
- nudge
- kill
- run upsert/registration
- message injection
- lifecycle cleanup/reclaim

## Relevant state transitions

### Normal task path

```text
queued -> claimed -> running -> done
queued -> claimed -> running -> failed
```

### Agent-owned failure

```text
claimed|running --pithos task fail(token)--> failed
```

### Operator interruption

```text
claimed|running --pithos run interrupt--> failed
```

Emits `task.interrupted`, not plain `task.failed`, while task status becomes `failed`.

### Natural process/session death

```text
claimed|running --pithos run cleanup-->
  queued       if attempts < max_attempts
  dead_letter  if attempts >= max_attempts
```

Cleanup does not increment attempts; attempts increment only on claim. Cleanup increments fencing tokens when invalidating an active claim.

### Planning repair

```text
queued|failed|dead_letter|cancelled --pithos task supersede--> replacement queued
queued --superseded--> cancelled
```

### Intentional abandon

```text
queued|failed|dead_letter --pithos task cancel--> cancelled
```

## `run cleanup` vs `run interrupt`

`run cleanup` is for natural lifecycle cleanup after pdx has confirmed the AFK process or HITL tmux target is gone. Harness hooks and agents do not call it.

`run interrupt` is for deliberate operator kill via `pdx kill`.

### `run cleanup`

Precondition: pdx has confirmed the run's execution resource is gone.

- terminal run: no-op
- no task: run -> `ended`
- task `done`: clear `runs.task_id`, run -> `ended`
- task `failed|dead_letter|cancelled`: clear `runs.task_id`, run -> `failed`
- task `claimed|running`: requeue/dead-letter by attempts/max_attempts, increment fencing token, clear run pointer, run -> `failed`

### `run interrupt`

- terminal run: no-op
- no task: run -> `cancelled`; no task mutation; no escalation from Pithos
- active held task: task -> `failed`, increment fencing token, clear run pointer, run -> `failed`, emit `task.interrupted`
- terminal held task: clear run pointer and end/fail run according to task state

`pdx`, not Pithos, creates the escalation task after an interrupt.

### `run timeout`

Used by pdx for non-Pandora no-claim sessions after the execution resource is killed and confirmed gone.

- terminal run: no-op
- no task: run -> `timed_out`
- any held task: fail loudly; no fallback branch in MVP
- no task mutation and no escalation from Pithos
- hardcoded no-claim timeout: 30 seconds

## Open points

Resolved in the main supervision spec:

- `pithos init --fresh` is the destructive clean-break reset command.
- Leases are removed from the MVP data model; fencing plus `runs.task_id` owns stale-write protection.
- Pithos seeds `agent_kinds`, `capabilities`, `agent_claims`, and `agent_enqueues`.
- `pdx status` must provide JSON; exact shape can remain loose for MVP.
- AFK and HITL session logs use the same underlying harness session-log mechanism as current tty-backed examples.
- No persisted pdx registry in MVP; startup settlement kills deterministic `pdx--*` tmux/process leftovers first, confirms they are gone, then cleans active built-in runs.
- Supervisor invalidation increments fencing tokens.
- Non-Pandora agents are capped to one live entry per `(agent, scope)` for MVP.
- Supervisor logs are structured JSONL and exposed through `pdx logs show`.
- Non-Pandora no-claim sessions time out after 30 seconds and become timed-out runs with no task mutation.
- Pandora direct chat is the bootstrap/human entry path; no bootstrap task is seeded.

Still open:

- None currently. The remaining implementation details should be resolved during implementation and review.
