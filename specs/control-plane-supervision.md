# Control Plane Supervision

**Status:** Planned
**Last Updated:** 2026-05-13

## 1. Overview

### Purpose

Introduce `pdx` as the local supervisor for Pandora's Box. The system has three layers:

1. **Pithos** owns durable state and invariants: scopes, built-in agents, capabilities, tasks, claims, runs, artifacts, events, fencing, and graph repair.
2. **Spawner** owns harness launch details: templates, prompt rendering, harness argv/env, AFK foreground launch, HITL tmux launch, and launch metadata.
3. **pdx** owns local supervision: reconcile loop, registry, caps, process/tmux ownership, immediate operator kill, and Pandora-facing control-plane status.

Agents claim work themselves through Pithos. The daemon never injects task content into prompts. AFK agents terminate by subprocess exit; HITL agents are tmux-backed and may wait for the user. Pandora is a long-lived HITL agent that claims `escalate` tasks.

### Goals

- Keep Pithos as the durable source of truth and enforce control-plane invariants in Pithos commands/schema.
- Keep spawner as a launcher-only library/module, with at most a dev/internal preview CLI.
- Use `pdx` as the only supervisor/operator API for status and immediate kill.
- Replace transcript-scraping completion detection with lifecycle signals: AFK process exit, HITL tmux disappearance, and explicit Pithos task completion/failure.
- Keep War/`execute` as the repo/worktree execution path and add Envy/`intake` only for external signal classification.
- Make human/Pandora checkpoints explicit queue nodes via the `escalate` capability.
- Keep the user's initial/human interface as direct chat with the live Pandora singleton; no bootstrap task is seeded.
- Remove duplicate lifecycle paths: no `pithos sweep`, no `pithos run end`, no `pithos run finish`, no spawner status/nudge/kill/message injection.
- Make pdx the only owner of run finalization. Agents and harness hooks finalize tasks and exit; pdx observes death and finalizes runs.

### Non-Goals

- Backwards compatibility with the current control-plane shape.
- Distributed or multi-host supervision.
- Population management beyond simple static caps.
- Solving live-but-wedged HITL sessions automatically.
- Reintroducing generic worker delegation beyond War/`execute`.

## 2. Compatibility

This is a destructive pre-v1 rewrite.

- `pithos init --fresh` is the explicit clean-break reset command: drop the old Pithos DB and initialise the current schema/seed data.
- Removed CLI surfaces are deleted with no aliases.
- Agent templates and manifest schema are rewritten with no compatibility shim.
- Code should not branch on old-vs-new behaviour.

## 3. Design Decisions

- **Decision:** Use three layers: Pithos, spawner, pdx.
  - **Rationale:** Pithos is durable truth, spawner is harness-specific launch mechanics, and pdx is local supervision policy. This prevents lifecycle/operator drift while allowing small tmux/process metadata to pass between layers.

- **Decision:** Spawner is launcher-only.
  - **Rationale:** Status, kill, nudge, run upsert, and cleanup require Registry/DB policy that Spawner must not own. Spawner may expose dev/internal preview helpers for rendered prompts.

- **Decision:** `pdx` exposes supervisor status and immediate kill, but no restart in MVP.
  - **Rationale:** Restarting a bad task can loop. The safer workflow is kill → escalate → Pandora and the user decide whether to supersede, cancel, or replan.

- **Decision:** `pdx` cancels queued work that cannot pass launch preconditions and escalates for repair.
  - **Rationale:** A repo/worktree directory can be deleted after a task was validly created. Retrying the same queued task would loop, while marking it failed would imply an agent attempted it. Cancelling the non-held task breaks the chain visibly and routes repair to Pandora through supersession or replanning.

- **Decision:** Launch-precondition cancellation and escalation are one durable Pithos transaction.
  - **Rationale:** Cancelling without persisting Pandora-visible repair work strands the chain. Pithos owns the atomic transition so pdx cannot observe a partially cancelled-but-not-escalated state.

- **Decision:** Missing scope runtime paths are classified separately from harness launch failures.
  - **Rationale:** A missing cwd makes one queued task unlaunchable until the scope is repaired. A missing harness binary, bad manifest, permission error, or subprocess failure is supervisor/operator configuration failure and must not silently cancel user work.

- **Decision:** `escalate` is a normal task capability consumed by Pandora.
  - **Rationale:** Artifacts record evidence/results; escalation tasks route attention. This gives Pandora an explicit queue-facing inbox without reintroducing prompt injection or long-running per-agent inbox files.

- **Decision:** Only `done` satisfies dependencies.
  - **Rationale:** A dependency means “must successfully complete first.” Failed, dead-lettered, or cancelled work breaks the chain and must be repaired explicitly.

- **Decision:** Supersede is the graph repair mechanism.
  - **Rationale:** Replacing a failed/cancelled/dead-lettered task with a fresh queued task preserves history while rewiring queued direct dependents onto the replacement.

- **Decision:** Split natural cleanup from deliberate interruption.
  - **Rationale:** Natural AFK/HITL death should requeue or dead-letter active work only after the old execution is confirmed gone. Operator kill should fail the held task immediately and escalate for human/Pandora intervention.

- **Decision:** Only pdx finalizes runs.
  - **Rationale:** Agent/harness code can complete or fail held tasks, but run terminalization depends on observed process/tmux lifecycle. Keeping run finalization in pdx prevents races between harness hooks and supervisor observations.

- **Decision:** `pdx` integrates with Pithos through the `@pdx/pithos` library, not by spawning the `pithos` CLI.
  - **Rationale:** CLI argv/stdout handling is the agent/operator contract. The supervisor needs typed in-process reuse of the same Pithos semantics so queue inspection and durable state transitions stay fast, testable, and schema-shaped without subprocess parsing or env plumbing.

- **Decision:** `pdx` resolves its data dir from `--data-dir`, then `PDX_DATA_DIR`, then `$HOME/.pdx`.
  - **Rationale:** Agents launched by the control plane receive the relevant harness environment, including `PDX_DATA_DIR`. Letting `pdx` honor that environment keeps Pandora's inspection commands simple while preserving explicit `--data-dir` as the highest-precedence operator override.

- **Decision:** Pithos seeds and enforces built-in agents/capabilities.
  - **Rationale:** Claim authorization is a durable invariant, not a template convention. Pre-v1 roster changes can be clean-break schema/seed updates.

- **Decision:** AFK and HITL session logs use the same harness session-log mechanism as today.
  - **Rationale:** The prior Pandora `status` script discovers Claude logs in `~/.claude/projects/**/<uuid>.jsonl` and Pi logs in `~/.pi/agent/sessions/**`. `claude`, `claude --print`, `pi`, and `pi --print` should remain inspectable by the same convention. The mode changes supervision, not log discovery.

## 4. Architecture

```text
pdx init
  -> normal init: reuse existing `<data-dir>` state
  -> `--clean`: remove db + runs + logs only, then continue; keeps templates and extensions
  -> `--nuke`: remove the full `<data-dir>` first, then continue
  -> `--clean` and `--nuke` are mutually exclusive
  -> pithos init (non-destructive)
  -> always re-seed `<data-dir>/templates/` from bundled defaults (read-only, 0444/0555)
  -> leave `<data-dir>/extensions/` untouched
  -> exit without touching tmux or Harness CLIs

pdx open
  -> fail loudly if a pdx daemon session already exists
  -> run the same data-dir/template initialization as `pdx init`
  -> start pdx daemon in tmux target `pdx--daemon`
  -> daemon startup settlement:
       kill deterministic old HITL tmux sessions matching `^pdx--`
       kill AFK orphans from pidfiles under `<data-dir>/runs/<run-id>.pid`
       confirm old execution resources are gone
       pithos run cleanup all active built-in-agent runs with reason `daemon_start`
  -> daemon upserts one long-lived `pdx` system run in global scope (`mode=afk`, `cwd=<pdx data-dir>`)
  -> daemon starts one long-lived Pandora HITL run in global scope regardless of queue state
  -> the user may chat directly with Pandora; Pandora records durable work by enqueueing tasks/artifacts
  -> Pandora claims `escalate` tasks when woken or when she checks the queue

pdx reconcile loop (each tick settles lifecycle before spawning)
  1. observe in-memory registry entries
  2. settle lifecycle events first:
       AFK death probe: process handle or `kill(pid, 0)`
       HITL death probe: `tmux has-session -t <target>`
       natural death already gone -> pithos run cleanup
       non-Pandora no-claim timeout (>30s) -> kill/confirm gone, then pithos run timeout
       non-Pandora HITL task cleared after an initial claim -> kill/confirm gone, then pithos run cleanup with reason `task_cleared`
       terminating entries -> retry kill once this tick until gone
  3. remove settled registry entries
  4. write pdx-paced heartbeat for live HITL entries when due
  5. inspect claimable tasks from Pithos
  6. maintain exactly one live Pandora singleton
  7. choose at most one ready non-Pandora task in seeded agent order (`envy`, `toil`, `greed`, `war`); `envy` is checked first so intake tasks are never starved behind steady triage/design/execute work
  8. validate the chosen task's launch cwd before run creation/render/launch
       global scope -> `<data-dir>` must be present
       repo/worktree scope -> `scope.canonical_path` must exist and be a directory
       missing/not-directory repo/worktree cwd -> cancel the queued task with preconditions, enqueue a global Repair Alert (kind=`launch_precondition`), and do not create a run
  9. spawn at most one AFK/HITL agent through spawner library according to manifest/policy and caps
       never pre-claim; spawned agents claim their own work via Pithos
       cap entries by in-memory registry, so a live launched-but-not-claimed agent still occupies its slot

pdx close
  -> fail loudly if no daemon is running
  -> stop spawning/reconcile
  -> kill AFK/HITL sessions, including Pandora
  -> confirm they are gone
  -> pithos run cleanup in-memory agent runs with reason `pdx_close`
  -> pithos run cleanup the `pdx` system run last with reason `pdx_close`
  -> close pdx tmux session

pdx run kill <run-id> --reason / pdx task kill <task-id> --reason
  -> pithos run interrupt first
  -> if a held task was interrupted, use the `pdx` system run to enqueue a global `escalate` task for Pandora
  -> mark registry entry terminating
  -> kill process/tmux immediately
  -> retry kill once per reconcile tick and structured-log each failure until gone
  -> remove registry entry after kill succeeds
```

Layer responsibilities:

| Layer   | Owns                                                                                               | Does not own                                        |
| ------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Pithos  | DB schema, seeded agents/capabilities, task/runs state transitions, graph repair, artifacts/events | OS processes, tmux supervision, harness argv        |
| Spawner | templates, prompt rendering, harness argv/env, AFK launch, HITL tmux creation, launch metadata     | registration, cleanup, status, kill, nudge, reclaim |
| pdx     | reconcile, in-memory registry, caps, process/tmux ownership, status, kill, nudges, supervisor logs | DB invariants, prompt/task content injection        |

`@pdx/pithos` is the supervisor-facing integration boundary. `pdx` calls typed library operations directly for queue inspection and run/task mutations. The `pithos` CLI is the agent/operator boundary only; when this spec says `pithos run cleanup`, `pithos briefing`, or similar in pdx flows, it names the corresponding Pithos operation and semantics, not a required subprocess invocation.

`pdx` has no persisted registry in MVP. On startup it does not adopt old sessions. It kills and confirms deterministic old tmux/process leftovers, cleans active built-in Pithos runs, and begins with a fresh in-memory registry. HITL leftovers are discovered with `tmux ls -F '#S'` filtered by `^pdx--`. AFK leftovers are discovered from pdx-owned pidfiles under `<data-dir>/runs/<run-id>.pid`; pdx writes pidfiles at AFK launch and removes them during cleanup.

No same-run resurrection exists. When an agent dies, pdx cleans up the old run and removes the registry entry; a later reconcile pass may spawn a fresh run that picks up durable state from Pithos and the filesystem/worktree.

`pdx` never pre-claims tasks. It uses claimable queue state only to decide whether to spawn. The spawned agent claims through `pithos task claim`. If the task was taken by the time the agent claims, the agent receives `NO_CLAIMABLE_WORK` and exits/finishes normally.

MVP caps:

- Pandora: exactly one live singleton while pdx is open.
- Non-Pandora agents: at most one live entry per `(agent, scope)`.
- AFK agents also respect global `--max-afk`.
- Supervised non-Pandora HITL sessions are single-task under pdx: after a run has ever claimed work and later clears `runs.task_id`, pdx reaps the idle tmux session instead of leaving it resident.
- Non-Pandora AFK agents are also conventionally expected to claim one task and exit/close, but Pithos only enforces one active task per run at a time.

Caps are counted from the in-memory registry, including `launching`, `live`, and `terminating` entries, not from DB run status. Future versions may expand this to safe concurrent work.

Default reconcile interval is 5 seconds. `pdx open --interval-seconds <n>` remains available for tuning. There is no backoff in MVP.

Spawn policy is intentionally simple in MVP: one spawn per reconcile tick, after lifecycle settlement, in seeded agent order (`pandora`, `envy`, `toil`, `greed`, `war`). `envy` is checked before `toil`/`greed`/`war` so intake tasks are not starved by steady triage/design/execute backlog. `repo` and `worktree` scopes use `scope.canonical_path` as cwd. `global` scope uses `<pdx data-dir>` as cwd.

Before pdx creates a non-Pandora run, renders a prompt, or calls Spawner, it validates that the selected task's cwd exists and is a directory. pdx performs a final cwd check immediately before `runUpsert`; a missing repo/worktree cwd at either pre-run check calls the atomic Pithos launch-precondition transition and does not create a run.

If the cwd exists through `runUpsert` but disappears before or during `launchRenderedAgent`, pdx first calls the Pithos launch-abort transition for the just-created no-claim run with reason `launch_precondition_failed`; that run becomes `cancelled` and never holds a task. pdx then calls the same atomic launch-precondition task transition only if the task remains queued and still matches the selected task id, scope id, and capability. A failed precondition means a race already changed durable truth; pdx logs structured context and lets the next reconcile tick observe the new state. Other launch failures remain tagged supervisor errors; they do not cancel tasks.

The 30 second No-claim session timeout is a registry bootstrap rule, not a generic `runs.task_id IS NULL` rule. It applies only to non-Pandora registry entries that have never observed an initial claim. Once a run has ever held a task, later idle/null `runs.task_id` periods are not No-claim sessions. Instead, pdx applies role-specific policy: Pandora remains long-lived, while non-Pandora HITL sessions are reaped after their first claimed task clears.

## 5. Data Model

### Seeded built-ins

`pithos init` seeds:

```text
scope: global

agent_kinds:
  pdx       # system actor only; not spawnable, no template, no claims
  pandora
  envy
  toil
  greed
  war

capabilities:
  intake
  triage
  design
  execute
  escalate

agent_claims:
  pandora -> escalate
  envy    -> intake
  toil    -> triage
  greed   -> design
  war     -> execute

agent_enqueues:
  pdx     -> escalate, intake
  pandora -> triage, design, escalate
  envy    -> triage, design, escalate
  toil    -> triage, design, execute, escalate
  greed   -> triage, design, escalate
  war     -> escalate
```

Suggested tables:

```sql
CREATE TABLE agent_kinds (
  agent_kind TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE capabilities (
  capability TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agent_claims (
  agent_kind TEXT NOT NULL REFERENCES agent_kinds(agent_kind),
  capability TEXT NOT NULL REFERENCES capabilities(capability),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_kind, capability)
);

CREATE TABLE agent_enqueues (
  agent_kind TEXT NOT NULL REFERENCES agent_kinds(agent_kind),
  capability TEXT NOT NULL REFERENCES capabilities(capability),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_kind, capability)
);
```

`pithos run upsert` validates `--agent` against `agent_kinds`. The seeded `pdx` agent kind is a system actor: it is not spawnable, has no manifest/template, has no claim authority, and is excluded from Registry/caps/no-claim timeout. Its global run authors supervisor-created Repair Alerts such as kill-induced Repair Alerts (kind=`interrupt`).

`pithos task enqueue` validates `--capability` against `capabilities`, enforces capability-specific task rules, validates that the target scope exists and is active, validates current repo/worktree scope directories when applicable, and validates `(run.agent_kind, requested_capability)` against `agent_enqueues`. Scope validation failures use `VALIDATION_ERROR` with contextual messages, for example: `scope not found: <scope-id>; create or reactivate it with pithos scope upsert first` or `scope path does not exist: <path>; create the directory, then run pithos scope upsert --kind <repo|worktree> --path <path>`.

`pithos task claim` validates `(run.agent_kind, requested_capability)` against `agent_claims` in the claim transaction.

A run may hold at most one active task. `pithos task claim` must atomically require `runs.task_id IS NULL` before claiming and setting `runs.task_id`; if the run already points at a task, claim fails loudly with a dedicated validation/user error. A partial unique index on `runs(task_id)` for non-null `task_id` prevents two runs from pointing at the same held task. This keeps `run cleanup` and `run interrupt` correct because both operate on the single held task pointer.

`pithos task claim` also validates the requested scope against the run's registered scope. MVP rule: the requested `--scope` must exactly match `runs.scope_id`. This prevents a run launched in one repo/worktree from claiming and mutating work in another cwd. Broader cross-scope behavior must be represented by enqueueing work into the target scope and spawning a run for that scope.

### Runs

Terminal run statuses include:

```text
ended, failed, cancelled, timed_out
```

`timed_out` is used for non-Pandora No-claim sessions that exceed the 30 second bootstrap timeout without a held task. `cancelled` is used for deliberate no-claim launch aborts, including the race where cwd disappears after `runUpsert` but before launch succeeds; Pithos records the abort reason such as `launch_precondition_failed` and no task is mutated by the run transition.

Add required `runs.mode`:

```sql
mode TEXT NOT NULL CHECK (mode IN ('afk','hitl'))
```

Mode is supplied by `pdx` at run upsert. Pithos stores it for audit and cleanup visibility; supervision policy remains in pdx.

Runs also store non-null launch transcript metadata:

```sql
harness_kind TEXT NOT NULL CHECK (harness_kind IN ('claude','pi','system')),
session_log_path TEXT NOT NULL CHECK (length(session_log_path) > 0)
```

`session_id`, `harness_kind`, and `session_log_path` are the durable index from a Pithos run to its transcript/log source. Spawned agent runs use `claude` or `pi`; the `pdx` system actor uses `system` and points at the supervisor log. `pdx run transcript <run-id>` only parses harness-backed `claude`/`pi` runs. For `system` runs it fails loudly and points operators to `pdx daemon logs`. Runtime ownership remains pdx Registry + OS/tmux probes; ephemeral values such as pid and current tmux target are not durable run truth.

Leases are removed from the MVP data model. There is no `lease_until`, `lease_owner_run_id`, or `--lease-minutes`. `runs.task_id` is the held-task owner pointer; Fencing tokens invalidate stale task writes. Heartbeat records run liveness/observability only and may advance a held task from `claimed` to `running`; it does not extend a lease. Pacing is owned by the caller (`pdx` or an agent recipe), not by a Pithos `--throttle` flag.

### Tasks and capabilities

Allowed statuses remain:

```text
queued, claimed, running, done, failed, dead_letter, cancelled
```

No new `blocked`/`escalated` status is added. Escalation is represented as a normal queued task with capability `escalate`.

Capability-specific enqueue/supersede validation:

| Capability | Required scope                                      | Body      | Notes                                     |
| ---------- | --------------------------------------------------- | --------- | ----------------------------------------- |
| `intake`   | `global`                                            | non-empty | external signal classification            |
| `triage`   | any active scope                                    | non-empty | decomposition/routing work                |
| `design`   | any active scope                                    | non-empty | design/research/alignment work            |
| `execute`  | `repo` or `worktree` with non-null `canonical_path` | non-empty | mutating or repo-local execution work     |
| `escalate` | `global`                                            | non-empty | Pandora and the user attention checkpoint |

Any task created in a `repo` or `worktree` scope also requires that scope's `canonical_path` to exist as a directory at enqueue/supersede time. This is a Pithos boundary validation, not a durable guarantee that the path will still exist when pdx later launches a run.

`pithos task supersede` applies the same validation to the replacement task after overrides. Because `escalate` is global-only, all Checkpoint escalation tasks and Repair Alerts live in global scope and reference original task/run/scope details in body or metadata.

## 6. Escalation and Repair

### Planned checkpoint escalation

Checkpoint escalations depend on successful prior work:

```text
triage -> design -> escalate(review design) -> triage(plan execution) -> execute... -> escalate(review result)
```

Because the dependency points at expected successful work, the escalation becomes claimable only after that work is `done`.

### Failure/interruption Repair Alert

Failure or interruption Repair Alerts must not depend on failed/cancelled/dead-lettered tasks, because only `done` satisfies dependencies. They are global-scope `escalate` tasks and reference the failed task/run/scope in body or metadata instead. When there is one affected task, the Repair Alert carries a `repair_source` link to that task for provenance; Pandora treats it as a repair source, not as a normal successful handoff target.

Example escalation body:

```text
Interrupted run requires attention

Run: run_abc
Task: task_xyz
Reason: agent editing wrong repo

Inspect:
- pithos task inspect task_xyz
- pithos run inspect run_abc

Expected resolution:
- supersede the failed task with corrected work, or
- cancel/replan downstream chain.
```

### Launch-precondition Repair Alert

A Launch-precondition Repair Alert is created by pdx when a queued non-Pandora task cannot be launched because the selected repo/worktree cwd is missing or not a directory before any run claims the task. pdx cancels the queued task instead of marking it failed, because no agent attempted the work. The Repair Alert is a normal global `escalate` task authored by the `pdx` system run.

Launch-precondition Repair Alerts must not depend on the cancelled task. The cancelled task is a broken dependency for downstream work, so depending on it would block Pandora forever. The Repair Alert carries a `repair_source` link to the cancelled task and includes the task id, scope id, canonical path, agent kind, capability, and cancel reason in the body.

The Pithos launch-precondition transition performs the task cancel, repair source-link creation, Repair Alert enqueue, and event writes in one transaction. It requires the expected task id, expected `queued` status, expected scope id, expected capability, expected reason, and absence of an active holder. If Repair Alert enqueue or source-link creation fails, the whole transition rolls back and pdx records a supervisor error instead of leaving a cancelled task without repair work.

Pandora must not resolve a Launch-precondition Repair Alert by enqueueing ordinary follow-up with default `--chain auto`, because the Repair Alert source is cancelled. Repair is either `pithos task supersede <cancelled-task>` after recreating/upserting the scope, or an explicit replan/cancel path using `--chain none` or named manual dependencies.

Example escalation body:

```text
Launch precondition failed: scope cwd missing

Task: task_xyz
Scope: repo:/path/to/repo
Canonical path: /path/to/repo
Agent: war
Capability: execute
Reason: scope_cwd_missing_at_launch

pdx cancelled the queued task before creating a run because the scope directory no longer exists.
Any queued dependents are now part of a broken chain until the cancelled task is superseded or the downstream work is replanned.

Expected resolution:
- recreate or restore the directory
- run pithos scope upsert --kind repo --path /path/to/repo
- inspect and supersede task_xyz with corrected equivalent work, or cancel/replan downstream chain
```

### Supersede repair

If a task in a chain fails:

```text
task1 done -> task2 failed -> task3 queued
```

Pandora/Toil can supersede `task2`:

```text
task1 done -> task2 failed
              ^ superseded by
            task2b queued -> task3 queued
```

Rules:

- `queued`, `failed`, `dead_letter`, and `cancelled` tasks may be superseded.
- `claimed` and `running` tasks may not be superseded; use `pdx run kill <run-id>` / `pdx task kill <task-id>` or `pithos run interrupt` first.
- Direct queued dependents are rewired to the replacement.
- Direct cancelled dependents are ignored; they are already terminal and need no retarget.
- Direct dependents in any other state (`claimed`, `running`, `done`, `failed`, `dead_letter`) cause supersede to fail loudly and require explicit replan.
- If `--scope` changes the replacement scope and there are queued direct dependents, fail loudly rather than silently retargeting dependents across scopes. Scope changes are allowed only when no queued direct dependents would be retargeted.
- If the old task was `queued`, it becomes `cancelled` in the same transaction.

## 7. CLI Interfaces

These commands are the public CLI contract for agents and operators. `pdx` does not shell out to this surface; it uses the corresponding `@pdx/pithos` library operations directly.

Clean-break nested command surface:

```text
pithos init [--fresh]

pithos scope upsert --kind <global|repo|worktree> [--path <path>]
pithos scope list [--all]
pithos scope archive <scope-id>

pithos run upsert \
  --agent <pdx|pandora|envy|toil|greed|war> \
  --mode <afk|hitl> \
  --scope <scope-id> \
  --cwd <path> \
  --session-id <session-id> \
  --harness-kind <claude|pi|system> \
  --session-log-path <path> \
  [--run <run-id>]

pithos run cleanup --run <run-id> --reason <text>

pithos run interrupt (--run <run-id> | --task <task-id>) --reason <text>

pithos run timeout --run <run-id> --reason <text>

pithos run inspect <run-id>

# Output minimum: { ok, run: { id, agent, mode, scope_id, status, task_id, session_id, harness_kind, session_log_path, created_at, updated_at } }

pithos task enqueue \
  --scope <scope-id> \
  --capability <intake|triage|design|execute|escalate> \
  --title <text> \
  --stdin \
  [--run <run-id>] \
  [--depends-on <task-id> ...]

# --run defaults from PITHOS_RUN_ID for mutating task commands; if both are present and differ, fail loudly.

pithos task claim \
  --run <run-id> \
  --scope <scope-id> \
  --capability <intake|triage|design|execute|escalate>

# --scope must match the run's registered scope; the run must not already hold a task.

pithos task heartbeat \
  --run <run-id> \
  [--task <task-id> --token <n>]

# Heartbeat records liveness/observability. With --task and --token, it may advance that held task from claimed to running. No hook names, lease extension, or CLI throttling exist in MVP.

pithos task complete <task-id> [--run <run-id>] --token <n> [--stdin]

pithos task fail <task-id> --run <run-id> --token <n> --reason <text>

pithos task supersede \
  <task-id> \
  [--run <run-id>] \
  --reason <text> \
  [--title <text>] \
  [--scope <scope-id>] \
  [--capability <intake|triage|design|execute|escalate>] \
  --stdin

pithos task cancel <task-id> --run <run-id> --reason <text>

# pdx library callers use the atomic launch-precondition transition:
# cancel queued task + source-linked escalation in one transaction.

pithos task inspect <task-id> [--json]

pithos task artifact add \
  <task-id> \
  [--run <run-id>] \
  --kind <kind> \
  --title <text> \
  --stdin

pithos graph inspect (--task <task-id> | --scope <scope-id> | --all) [--json]

pithos events tail [--limit <n>]

pithos briefing [--agent pandora] [--json]
```

`pithos scope upsert --kind repo|worktree --path <path>` resolves the canonical path and requires it to exist as a directory. Missing paths, files, and broken symlinks fail with tagged JSON telling the caller to create the directory first, then upsert the scope. `global` scope does not accept a runtime path.

The Pithos library exposes a supervisor-only launch-precondition transition for pdx. Input includes expected task id, expected scope id, expected capability, canonical path, agent kind, reason, and escalation body. The transition atomically verifies the task is still queued and unheld, cancels it, creates a global `escalate` task authored by the `pdx` system run, records a `repair_source` link from that escalation to the cancelled task, and emits events. It is not a public CLI shortcut because operators should use normal `task cancel` or `task supersede` explicitly.

The Pithos library also exposes Repair Alert creation for pdx/system callers. Input includes escalation title/body, affected task id, `kind`, and `source_kind: repair_source`. pdx uses it for interruption/failure Repair Alerts after `run interrupt` returns an affected task, so those Repair Alerts carry the same non-blocking repair provenance as Launch-precondition Repair Alerts.

Removed/not exposed:

```text
pithos sweep
pithos run end
pithos run finish
top-level enqueue/claim/heartbeat/complete/fail/supersede/tail/artifact/inspect
manual/operator task enqueue without a run
```

### `pithos init --fresh`

Drops the existing DB file and initialises the current schema/seed data. Normal `pithos init` is idempotent and non-destructive.

### `pithos run cleanup`

Used for natural lifecycle cleanup after pdx has confirmed the AFK process or HITL tmux target is gone. Callers: AFK exit observation, HITL tmux disappearance, non-Pandora HITL single-task reap after `task_cleared`, pdx startup cleanup after orphan kill, and pdx close after child sessions are gone.

Agents and harness hooks do not call `run cleanup`; they complete/fail tasks and exit. pdx observes lifecycle and finalizes runs.

- terminal run: no-op
- no task: run -> `ended`
- task `done`: clear `runs.task_id`, run -> `ended`
- task `failed|dead_letter|cancelled`: clear `runs.task_id`, run -> `failed`
- task `claimed|running`:
  - attempts are not incremented; attempts increment only on claim
  - if `attempts < max_attempts`: task -> `queued`, increment fencing token, emit `task.reclaimed`
  - if `attempts >= max_attempts`: task -> `dead_letter`, increment fencing token, emit `task.dead_lettered`
  - clear `runs.task_id`, run -> `failed`

The active-task update is fenced against the captured `runs.task_id`, task status, and fencing token. If the fenced update affects zero rows, the transaction fails and pdx retries on the next pass. `task.reclaimed` / `task.dead_lettered` payloads include `previous_run_id`, `reason`, `attempts`, `max_attempts`, `previous_fencing_token`, and `new_fencing_token`.

### `pithos run interrupt`

Used for deliberate operator interruption via `pdx run kill` or `pdx task kill`.

- terminal run: no-op
- no task: run -> `cancelled`; no task mutation; no escalation from Pithos
- active held task: task -> `failed`, increment fencing token, clear run pointer, run -> `failed`, emit `task.interrupted`
- terminal held task: clear run pointer and end/fail run according to task state

The active-task update is fenced against the captured `runs.task_id`, task status, and fencing token. `task.interrupted` payload includes `run_id`, `reason`, `previous_status`, `previous_fencing_token`, and `new_fencing_token`.

`pdx`, not Pithos, creates a follow-up escalation task after interrupting a held task.

### `pithos run timeout`

Used by pdx for non-Pandora No-claim session timeout after the execution resource has been killed and confirmed gone.

- only valid when `runs.task_id IS NULL`
- terminal run: no-op
- non-terminal run with no held task: run -> `timed_out`
- if `runs.task_id IS NOT NULL`, fail loudly; no fallback branch in MVP
- no task mutation and no escalation from Pithos

No-claim timeout is hardcoded to 30 seconds in MVP and excludes Pandora.

Output minimum:

```json
{ "ok": true, "run": { "id": "run_...", "status": "timed_out" } }
```

### Pithos run launch abort (library-only)

Used by pdx when a run row was created for launch but no execution resource successfully started and no task was claimed. The run becomes `cancelled`, `runs.task_id` remains null, and no task is mutated by this run transition. The reason distinguishes the abort cause, for example `launch_precondition_failed` when cwd disappears between `runUpsert` and `launchRenderedAgent`. The transition emits `run.launch_aborted`.

### `pithos task cancel`

Intentional abandon.

- Allowed for `queued`, `failed`, and `dead_letter` tasks.
- Not allowed for `claimed` or `running`; use `pdx run kill <run-id>` / `pdx task kill <task-id>` or `pithos run interrupt`.
- Not allowed for `done`.
- Emits `task.cancelled`.
- Supervisor/library callers that cancel due to a launch precondition must use the atomic launch-precondition transition rather than plain cancel. It applies fenced preconditions, cancels the queued task, creates the source-linked escalation, and commits only if the whole repair handoff is persisted.

## 8. pdx Interfaces

Minimal operator/Pandora-facing API:

```text
pdx init [--data-dir <path>] [--clean | --nuke]
pdx open [--data-dir <path>] [--interval-seconds <n>] [--max-afk <n>] [--clean | --nuke]
pdx close [--data-dir <path>]

pdx daemon status [--data-dir <path>]
pdx daemon logs [--data-dir <path>] [--limit <n> | --all] [--since <when>]

pdx run kill <run-id> --reason <text> [--data-dir <path>]
pdx run transcript <run-id> [--data-dir <path>] [--limit <n>]
pdx run show <run-id> [--data-dir <path>]

pdx task kill <task-id> --reason <text> [--data-dir <path>]
pdx task show <task-id> [--data-dir <path>]
```

All `pdx` commands resolve the data dir with precedence `--data-dir`, then `PDX_DATA_DIR`, then `$HOME/.pdx`. The environment fallback lets spawned agents run `$PDX_BIN run transcript`, `$PDX_BIN run show`, or `$PDX_BIN task show` against the same control-plane data dir without spelling `--data-dir`; explicit `--data-dir` remains the operator override.

The internal daemon process entrypoint is `pdx daemon run`; it is used by `pdx open` inside tmux and is intentionally omitted from public help/API docs. `pdx daemon` is the public daemon namespace only.

`pdx daemon status` must have JSON output. The exact shape is intentionally loose for MVP; Pandora can consume and adapt to the available fields. It must include top-level keys `daemon`, `registry`, `queue`, and `caps`. It should include at least:

- daemon liveness
- in-memory registry entries with raw IDs and friendly names (`run_id`, `task_id`, `session_id`, `agent`, `scope_id`, `mode`, `logical_name`, `tmux_target` for HITL, `pid` for AFK, `state`)
- claimable queue counts by scope/capability
- cap usage, including global `max_afk`
- recent in-memory supervisor events/errors

If no daemon is running, `pdx daemon status` returns successful JSON with `daemon.running = false`. If state cannot be determined due to tmux/process errors, it fails loudly.

`pdx daemon logs` reads the structured supervisor JSONL log even when the daemon is stopped. It prints raw original JSONL lines so Pandora can pipe to `jq`. These are pdx supervisor logs, not agent harness transcripts.

- default: last 100 lines
- `--limit <n>`: last N matching lines
- `--all`: all matching lines
- `--since <when>` filters by log timestamp before applying the limit
- accepted `--since` forms: ISO timestamp, durations (`10m`, `1h`, `2d`, `1w`), `today`, `yesterday`
- `today`/`yesterday` use local time boundaries
- missing/unreadable log file, invalid `--since`, or corrupt JSONL fails loudly

`pdx run kill` and `pdx task kill` must be immediate and scheduler-visible:

1. Mutate Pithos first with `pithos run interrupt`.
2. `pdx task kill <task-id>` means “interrupt the live run currently holding this task.” If no run currently holds that task, fail loudly and point to `pithos task cancel` for non-held task abandonment.
3. `pithos run interrupt` resolves the owning run from Pithos DB state for task-keyed interruption, not from pdx Registry. If zero active owning runs exist, fail loudly.
4. If the interrupt returned a held task, use the global `pdx` system run to enqueue a global `escalate` task for Pandora referencing the interrupted task/run/scope.
5. Mark the registry entry `terminating` so caps still count it and reconcile does not respawn while kill is in progress.
6. Kill the OS process or tmux session immediately.
7. Retry kill once per reconcile tick and emit a structured supervisor log entry for each failed attempt. No max retry or escalation path in MVP.
8. Remove the registry entry only after kill succeeds.

`pdx run transcript <run-id>` is the pdx-owned replacement for the old spawner status command. It inspects the Pithos run, parses its non-null `harness_kind` and `session_log_path`, and delegates harness-log parsing to the Spawner library. Default `--limit` is 20. Output is plain text, one transcript event per line:

```text
[2026-05-10 14:30:01] ASSISTANT: concise one-line message or tool summary
[2026-05-10 14:30:05] USER: concise one-line message
```

System runs, missing session log files, unreadable files, unsupported `harness_kind`, corrupt JSONL, or malformed run metadata fail loudly. DB run state remains `pithos run inspect <run-id>`; task state remains `pithos task inspect <task-id>`.

`pdx run show <run-id>` switches the current tmux client to the supervised HITL session for that run. It fails loudly if the run is not currently supervised or if the run is AFK and therefore has no tmux session.

`pdx task show <task-id>` resolves the active holder run for that task from Pithos, then delegates to `pdx run show`. It fails loudly if the task has no active holder or if the holder run has no live tmux session.

No `pdx restart` in MVP. Recovery is explicit through Pandora and the user and graph repair.

On successful `pdx open`, the CLI prints `tmux attach -t pdx--pandora` and exits. It does not auto-attach.

`pdx` may send a content-free nudge to live Pandora when claimable `escalate` work appears. Transport is `tmux send-keys` to `pdx--pandora` with a marker line followed by Enter:

```text
<pithos-event>escalation-ready</pithos-event>
```

The marker contains no task body and is not semantic task injection. The nudge may be deferred up to `DEBOUNCE_MAX_SECONDS` seconds when an operator client is attached to `pdx--pandora` and has been active within the last `ACTIVE_WINDOW_SECONDS` seconds; after the cap it is force-delivered.

HITL tmux naming uses a BEM-ish Pandora-owned convention:

```text
pdx--daemon
pdx--pandora
pdx--<agent>__<scope-slug>--<session-short>
```

AFK agents use the same `logical_name` convention in logs/status even though they do not have tmux sessions.

Supervisor logs are structured JSONL at an internal pdx-controlled path such as `<data-dir>/pdx.jsonl`. Use structured `Effect.log*` output and spans per project rules; do not write unstructured daemon logs. Every supervisor log line includes at least `ts`, `level`, `span`, and `msg`.

The internal daemon tmux pane may also print concise human-readable lifecycle pulses (for example spawn/remove/nudge) to stdout for operator visibility. Those pulses are ephemeral operator affordances, not the durable or machine-readable supervisor log contract.

## 9. Spawner Interface

Spawner is primarily a library/module used by `pdx`.

Layered library API exported from `@pdx/spawner` package root:

```ts
renderAgent(input): RenderedAgent
launchRenderedAgent(rendered): LaunchResult
launchAgent(input): LaunchResult
renderSessionTranscript(input): string
```

The package root also exports the public service interfaces and intended live implementation used by consumers. Consumers must import `@pdx/spawner`, not sibling package `src/*` internals.

`renderAgent` is pure render/preview: no Pithos mutation, no process launch, no tmux creation. It loads and validates manifest/templates, validates supplied mode against manifest mode, renders the prompt, builds harness argv/env, and generates `claim_command`. When `PDX_DATA_DIR` is set, manifest/templates are loaded from `<data-dir>/templates/`; otherwise the bundled repo-root `templates/` directory is used. `pdx` passes its resolved data dir into Spawner, so rendered Harness env includes the same `PDX_DATA_DIR` whenever a control-plane data dir is in use.

`launchRenderedAgent` launches an already rendered plan and returns runtime launch metadata. `launchAgent` is a convenience wrapper that calls `renderAgent` then `launchRenderedAgent`; `pdx` uses `renderAgent` before run upsert, persists non-null transcript metadata, then calls `launchRenderedAgent` so the launched process exactly matches the persisted render plan.

`renderSessionTranscript` owns harness-specific Claude/Pi session-log parsing. `pdx run transcript` uses this library API after resolving run transcript metadata through Pithos.

Input shape for `renderAgent` / `launchAgent`:

```ts
{
	agent: AgentKind;
	mode: "afk" | "hitl";
	runId: string;
	sessionId: string;
	scopeId: string;
	cwd: string;
}
```

`RenderedAgent` shape:

```ts
{
  agent: AgentKind
  mode: "afk" | "hitl"
  runId: string
  sessionId: string
  scopeId: string
  cwd: string
  logicalName: string
  harness: { kind: "claude" | "pi"; argv: readonly string[]; env: Record<string, string> }
  sessionLogPath: string
  prompt: string
}
```

`RenderSessionTranscriptInput` shape:

```ts
{
  harnessKind: "claude" | "pi"
  sessionLogPath: string
  limit?: number // default 20
}
```

`LaunchResult` shape:

```ts
{
  agent: AgentKind
  mode: "afk" | "hitl"
  runId: string
  sessionId: string
  scopeId: string
  logicalName: string
  harnessKind: "claude" | "pi"
  sessionLogPath: string
  afk?: { pid: number; processStartTime: string }
  hitl?: { tmuxTarget: string; panePid: number | null }
}
```

`LaunchResult` intentionally omits rendered argv/env. Those belong to the `RenderedAgent` launch plan. `pdx` logs the plan separately as supervisor observability before launch; the launch result reports runtime process/tmux metadata.

Agent mode is manifest-declared. `pdx` renders through Spawner first, upserts the run with the rendered mode, `harness.kind`, and `sessionLogPath`, then launches the rendered plan. Spawner validates the supplied mode against the manifest so mismatches fail loudly.

`pdx` owns ID generation and run upsert. Spawner requires caller-supplied `runId` and UUID `sessionId`; it does not generate them and does not create run rows.

Spawner/template context contains self-claim context, not task content:

- `agent`
- `run_id`
- `session_id`
- `scope_id`
- `cwd`
- generated `claim_command`
- generated, role-filtered command help JSON

Templates do not receive full `pithos --help` by default. Spawner calls `pithos --help-json` and filters the generated Pithos JSON help tree by role: AFK evils receive the `pithos task` branch, while Pandora receives `pithos task`, `pithos graph`, `pithos events`, and `pithos briefing`. Pandora also receives filtered pdx JSON help for `pdx run transcript`, `pdx run show`, and `pdx task show`. `pdx daemon status` and `pdx daemon logs` remain public operator commands, but are not included in Pandora's default filtered command cards. Missing configured help paths or malformed help JSON fail rendering loudly.

Spawner renders `claim_command` from the built-in claim capability for that agent plus launch context, for example:

```sh
pithos task claim --run <run-id> --scope <scope-id> --capability <claim>
```

Pithos still enforces claim authorization and one-active-task-per-run.

Manifest entries declare agent mode plus harness runtime tuning. Claim/enqueue authorization remains in Pithos built-ins and Spawner derives that metadata at render time:

```json
{
	"agent": "war",
	"mode": "afk",
	"harness": {
		"kind": "claude",
		"model": "sonnet",
		"system_prompt_mode": "replace",
		"tools": ["Bash", "Read", "Edit", "Write"]
	},
	"includes": ["_common.md"],
	"template": "war.md"
}
```

Harness config rules:

- `model` is required and rendered as `--model <model>` for both Claude and Pi.
- `system_prompt_mode` is required. `replace` renders `--system-prompt <prompt>`; `append` renders `--append-system-prompt <prompt>`.
- `tools` is optional. If omitted, no `--tools` flag is rendered and the harness default applies. If present, it must be non-empty and renders as one comma-separated `--tools <a,b,c>` argument. Tool names are not validated by Spawner; they are harness-owned strings and may change without code changes.
- `argv` is optional. If present, tokens are inserted verbatim into the harness command line immediately after the binary name and before all Spawner-managed flags, for both harnesses and both modes. Each element must be non-empty. This is a generic escape hatch for harness CLI features not modeled by other fields (e.g. `["--plugin-dir", "~/my-plugins"]` for Claude Code). Spawner does not interpret or expand argv values.
- `includes` is optional. Include paths must be unique. Relative paths are loaded from the templates directory; absolute paths are loaded directly; `~/` paths expand to the current user's home directory. Each listed include is loaded as raw text and becomes a template variable keyed by the exact manifest string, for example `{{_common.md}}`, `{{snippets/common.md}}`, or `{{~/agent/common.md}}`. Includes are not recursively rendered. Unknown template variables fail loudly.

Responsibilities:

- load and validate manifest/templates
- render prompts
- build harness argv/env
- launch AFK foreground process and return process metadata to pdx
- launch HITL tmux session and return tmux metadata to pdx
- return the expected harness-native session log path using the same discovery convention as the prior Pandora `status` script

AFK harness argv must run the harness in non-interactive print mode so a stdio-detached process actually performs one task and exits. For Pi and Claude, AFK argv includes `--print "Claim and process one task, then exit."`; HITL argv omits `--print` and runs interactively in tmux. All Spawner session IDs must be valid UUIDs.

Session logs follow the harness-native discovery convention from the prior Pandora `status` script: Claude logs live under `~/.claude/projects/**/<uuid>.jsonl`; Pi logs live under `~/.pi/agent/sessions/**/<uuid>.jsonl` or `~/.pi/agent/sessions/**/*_<uuid>.jsonl`. The rendered plan includes the expected `sessionLogPath`, and Pithos stores that path on the run. `renderSessionTranscript` reads the stored path; it does not rediscover path ownership from the current manifest.

Dev/internal CLI may expose:

```text
pandora-spawn preview --agent <name> --mode <afk|hitl> --scope <scope-id> --run <run-id> --session-id <session-id> --cwd <path>
```

Preview output is JSON `RenderedAgent`, including prompt and harness argv/env. Preview performs manifest/template validation only; it does not validate Pithos run/scope state. Because preview renders the exact harness environment, it requires DB context: either `PITHOS_DB` or `PDX_DATA_DIR` from which Spawner derives `<data-dir>/pithos.sqlite`. When `PDX_DATA_DIR` is supplied, preview also reads manifest/templates from `<data-dir>/templates/`; otherwise it reads the bundled repo-root `templates/` defaults. Help-JSON probes and launched agents resolve bare `pithos`/`pdx` from PATH; `PDX_DATA_DIR` controls data/templates, not CLI binary location.

Spawner error codes:

- `VALIDATION_ERROR`
- `TEMPLATE_ERROR`
- `HARNESS_ERROR`
- `LAUNCH_ERROR`

Not exposed:

```text
status
nudge
kill
run upsert/registration
message injection
lifecycle cleanup/reclaim
```

AFK and HITL session-log discovery follows the harness-native convention used by the prior Pandora `status` script.

## 10. Agent Contract

Templates receive explicit run/scope/cwd context and a generated self-claim command.

Every claiming agent follows:

```text
<claim_command>
pithos task inspect <task-id>
# do work
printf '%s\n' '<artifact body>' | pithos task artifact add <task-id> --run <run-id> --kind <kind> --title <text> --stdin
pithos task complete <task-id> --run <run-id> --token <token>
```

`task complete` uses no stdin for the default `{}` result metadata. Use `task complete --stdin` only for JSON object metadata; long-form work products belong in Artifacts.

Pithos invariant: a run may hold at most one active task at a time. After completing/failing a task and clearing `runs.task_id`, the same run may claim another task. `pdx` applies a narrower MVP supervision policy on top: Pandora is long-lived and may repeatedly claim `escalate` tasks sequentially, but supervised non-Pandora HITL sessions are single-task and are reaped after their first observed claim clears. Envy/Toil/War AFK runs are also conventionally expected to claim one task and exit/close for context management.

Per-agent roles and enqueue authority:

- **Pandora** claims `escalate`, discusses with the user, investigates with Pithos state plus `pdx daemon status`, `pdx daemon logs`, and `pdx run transcript`, and decides whether to supersede/cancel/replan/enqueue follow-up. When the user asks to drain escalations, Pandora processes them sequentially because one run may hold only one task at a time. Routine Greed review nudges with an already-attached `design-brief` artifact count as approved design and may be completed without re-asking the user. She may enqueue `triage`, `design`, and `escalate`, but not `execute`; execution goes through Toil.
- **Envy** claims `intake`, classifies one external signal, and enqueues exactly one downstream `triage`, `design`, or `escalate` task in global scope. Envy does not perform implementation, deep decomposition, or fan-out in MVP.
- **Toil** claims `triage`, decomposes and routes work, and may enqueue `triage`, `design`, `execute`, and checkpoint `escalate` tasks. Toil may supersede/cancel non-held tasks when repairing a broken chain.
- **Greed** claims `design`, performs the interactive design review in a live HITL session, and first enqueues a global `escalate` task when ready for the user to review/sign off. Greed attaches the final `design-brief` artifact only after the user signs off directly or Pandora relays explicit sign-off, then completes the held task. Once that task clears, pdx reaps the non-Pandora HITL session. Greed may enqueue `design`, `triage`, and `escalate` when the design session branches or is ready for follow-up. Greed does not enqueue `execute` in MVP.
- **War** claims `execute`, performs repo/worktree execution, produces `war-completion` artifacts, and may enqueue `escalate` when attention is needed. War does not enqueue further `execute` tasks in MVP.

## 11. Event Vocabulary

Pithos events are durable audit records. Payloads may grow, but these event names and minimum fields are part of the control-plane contract.

| Event                | Keys                               | Minimum payload                                                                                                                            |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `task.created`       | `task_id`, optional `actor_run_id` | `scope_id`, `capability`, `title`, `depends_on_task_ids`, optional `supersedes_task_id`, optional `source_task_id`, optional `source_kind` |
| `task.claimed`       | `task_id`, `actor_run_id`          | `run_id`, `fencing_token`                                                                                                                  |
| `task.heartbeat`     | `task_id`, `actor_run_id`          | `run_id`, `fencing_token`, `previous_status`, `status`                                                                                     |
| `run.heartbeat`      | `run_id`                           | `status`                                                                                                                                   |
| `task.completed`     | `task_id`, `actor_run_id`          | `run_id`, `fencing_token`                                                                                                                  |
| `task.failed`        | `task_id`, `actor_run_id`          | `run_id`, `fencing_token`, `reason`                                                                                                        |
| `task.cancelled`     | `task_id`, `actor_run_id`          | `reason`, optional `superseded_by_task_id`                                                                                                 |
| `task.superseded`    | old `task_id`, `actor_run_id`      | `new_task_id`, `reason`, `retargeted_dependent_task_ids`                                                                                   |
| `task.reclaimed`     | `task_id`, `run_id`                | `previous_run_id`, `reason`, `attempts`, `max_attempts`, `previous_fencing_token`, `new_fencing_token`                                     |
| `task.dead_lettered` | `task_id`, `run_id`                | `previous_run_id`, `reason`, `attempts`, `max_attempts`, `previous_fencing_token`, `new_fencing_token`                                     |
| `task.interrupted`   | `task_id`, `run_id`                | `run_id`, `reason`, `previous_status`, `previous_fencing_token`, `new_fencing_token`                                                       |
| `run.cleanup`        | `run_id`                           | `reason`, `previous_status`, `status`, optional `task_id`                                                                                  |
| `run.interrupted`    | `run_id`                           | `reason`, `previous_status`, `status`, optional `task_id`                                                                                  |
| `run.timed_out`      | `run_id`                           | `reason`, `previous_status`, `status`                                                                                                      |
| `run.launch_aborted` | `run_id`                           | `reason`, `previous_status`, `status`                                                                                                      |

`specs/task-graph.md` defines graph semantics for dependency and supersession payloads; this table is the consolidated event vocabulary for the control-plane rewrite.

## 12. Implementation Locations

| Area                           | Files                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| Pithos library + CLI surface   | `packages/pithos/src/`, `packages/pithos/test/`, `packages/pithos/README.md`              |
| Spawner launcher-only refactor | `packages/spawner/src/`, `templates/`                                                     |
| pdx package                    | `packages/pdx/`                                                                           |
| Docs                           | `README.md`, `packages/pithos/README.md`, `packages/spawner/README.md`, `specs/README.md` |

## 13. Open Questions

- **No-claim post-timeout policy:** After a non-Pandora run times out or dies before its first claim, should pdx immediately allow a fresh run for the same `(agent, scope)`, apply a bounded retry/backoff policy, or create an escalation before retrying? Current MVP behavior should remain minimal and explicit; do not add silent suppression without a specified policy.
