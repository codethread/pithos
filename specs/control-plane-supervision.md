# Control Plane Supervision

**Status:** Planned
**Last Updated:** 2026-05-09

## 1. Overview

### Purpose

Introduce `pdx` as the local supervisor for Pandora's Box. The system has three layers:

1. **Pithos** owns durable state and invariants: scopes, built-in agents, capabilities, tasks, claims, runs, artifacts, events, fencing, and graph repair.
2. **Spawner** owns harness launch details: templates, prompt rendering, harness argv/env, AFK foreground launch, HITL tmux launch, and launch metadata.
3. **pdx** owns local supervision: reconcile loop, registry, caps, process/tmux ownership, immediate operator kill, and Pandora-facing control-plane status.

Agents claim work themselves through Pithos. The daemon never injects task content into prompts. AFK agents terminate by subprocess exit; HITL agents are tmux-backed and may wait for Adam. Pandora is a long-lived HITL agent that claims `escalate` tasks.

### Goals

- Keep Pithos as the durable source of truth and enforce control-plane invariants in Pithos commands/schema.
- Keep spawner as a launcher-only library/module, with at most a dev/internal preview CLI.
- Use `pdx` as the only supervisor/operator API for status and immediate kill.
- Replace transcript-scraping completion detection with lifecycle signals: AFK process exit, HITL tmux disappearance, and explicit Pithos task completion/failure.
- Replace Envy/Worker/`implement` with War/`execute`.
- Make human/Pandora checkpoints explicit queue nodes via the `escalate` capability.
- Keep Adam's initial/human interface as direct chat with the live Pandora singleton; no bootstrap task is seeded.
- Remove duplicate lifecycle paths: no `pithos sweep`, no `pithos run end`, no `pithos run finish`, no spawner status/nudge/kill/message injection.
- Make pdx the only owner of run finalization. Agents and harness hooks finalize tasks and exit; pdx observes death and finalizes runs.

### Non-Goals

- Backwards compatibility with the current control-plane shape.
- Distributed or multi-host supervision.
- Population management beyond simple static caps.
- Solving live-but-wedged HITL sessions automatically.
- Reintroducing Envy or worker delegation in MVP.

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
  - **Rationale:** Restarting a bad task can loop. The safer workflow is kill → escalate → Pandora/Adam decide whether to supersede, cancel, or replan.

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

- **Decision:** `pdx` integrates with Pithos through the `@pithos/pithos` library, not by spawning the `pithos` CLI.
  - **Rationale:** CLI argv/stdout handling is the agent/operator contract. The supervisor needs typed in-process reuse of the same Pithos semantics so queue inspection and durable state transitions stay fast, testable, and schema-shaped without subprocess parsing or env plumbing.

- **Decision:** Pithos seeds and enforces built-in agents/capabilities.
  - **Rationale:** Claim authorization is a durable invariant, not a template convention. Pre-v1 roster changes can be clean-break schema/seed updates.

- **Decision:** AFK and HITL session logs use the same harness session-log mechanism as today.
  - **Rationale:** The prior Pandora `status` script discovers Claude logs in `~/.claude/projects/**/<uuid>.jsonl` and Pi logs in `~/.pi/agent/sessions/**`. `claude`, `claude --print`, `pi`, and `pi --print` should remain inspectable by the same convention. The mode changes supervision, not log discovery.

## 4. Architecture

```text
pdx open
  -> fail loudly if a pdx daemon session already exists
  -> pithos init (non-destructive)
  -> start pdx daemon in tmux target `pdx--daemon`
  -> daemon startup settlement:
       kill deterministic old HITL tmux sessions matching `^pdx--`
       kill AFK orphans from pidfiles under `<data-dir>/runs/<run-id>.pid`
       confirm old execution resources are gone
       pithos run cleanup all active built-in-agent runs with reason `daemon_start`
  -> daemon upserts one long-lived `pdx` system run in global scope (`mode=afk`, `cwd=<pdx data-dir>`)
  -> daemon starts one long-lived Pandora HITL run in global scope regardless of queue state
  -> Adam may chat directly with Pandora; Pandora records durable work by enqueueing tasks/artifacts
  -> Pandora claims `escalate` tasks when woken or when she checks the queue

pdx reconcile loop (each tick settles lifecycle before spawning)
  1. observe in-memory registry entries
  2. settle lifecycle events first:
       AFK death probe: process handle or `kill(pid, 0)`
       HITL death probe: `tmux has-session -t <target>`
       natural death already gone -> pithos run cleanup
       non-Pandora no-claim timeout (>30s) -> kill/confirm gone, then pithos run timeout
       terminating entries -> retry kill once this tick until gone
  3. remove settled registry entries
  4. write pdx-paced heartbeat for live HITL entries when due
  5. inspect claimable tasks from Pithos
  6. maintain exactly one live Pandora singleton
  7. spawn at most one AFK/HITL agent through spawner library according to manifest/policy and caps
       seeded order: pandora, toil, greed, war
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

| Layer   | Owns                                                                                                | Does not own                                        |
| ------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Pithos  | DB schema, seeded agents/capabilities, task/runs state transitions, graph repair, artifacts/events  | OS processes, tmux supervision, harness argv        |
| Spawner | templates, prompt rendering, harness argv/env, AFK launch, HITL tmux creation, launch metadata      | registration, cleanup, status, kill, nudge, reclaim |
| pdx     | reconcile, in-memory registry, caps, process/tmux ownership, status, kill, wakeups, supervisor logs | DB invariants, prompt/task content injection        |

`@pithos/pithos` is the supervisor-facing integration boundary. `pdx` calls typed library operations directly for queue inspection and run/task mutations. The `pithos` CLI is the agent/operator boundary only; when this spec says `pithos run cleanup`, `pithos briefing`, or similar in pdx flows, it names the corresponding Pithos operation and semantics, not a required subprocess invocation.

`pdx` has no persisted registry in MVP. On startup it does not adopt old sessions. It kills and confirms deterministic old tmux/process leftovers, cleans active built-in Pithos runs, and begins with a fresh in-memory registry. HITL leftovers are discovered with `tmux ls -F '#S'` filtered by `^pdx--`. AFK leftovers are discovered from pdx-owned pidfiles under `<data-dir>/runs/<run-id>.pid`; pdx writes pidfiles at AFK launch and removes them during cleanup.

No same-run resurrection exists. When an agent dies, pdx cleans up the old run and removes the registry entry; a later reconcile pass may spawn a fresh run that picks up durable state from Pithos and the filesystem/worktree.

`pdx` never pre-claims tasks. It uses claimable queue state only to decide whether to spawn. The spawned agent claims through `pithos task claim`. If the task was taken by the time the agent claims, the agent receives `NO_CLAIMABLE_WORK` and exits/finishes normally.

MVP caps:

- Pandora: exactly one live singleton while pdx is open.
- Non-Pandora agents: at most one live entry per `(agent, scope)`.
- AFK agents also respect global `--max-afk`.
- Each spawned non-Pandora agent is conventionally expected to claim one task and exit/close, but Pithos only enforces one active task per run at a time.

Caps are counted from the in-memory registry, including `launching`, `live`, and `terminating` entries, not from DB run status. Future versions may expand this to safe concurrent work.

Default reconcile interval is 5 seconds. `pdx open --interval-seconds <n>` remains available for tuning. There is no backoff in MVP.

Spawn policy is intentionally simple in MVP: one spawn per reconcile tick, after lifecycle settlement, in seeded agent order (`pandora`, `toil`, `greed`, `war`). `repo` and `worktree` scopes use `scope.canonical_path` as cwd. `global` scope uses `<pdx data-dir>` as cwd.

The 30 second No-claim session timeout is a registry bootstrap rule, not a generic `runs.task_id IS NULL` rule. It applies only to non-Pandora registry entries that have never observed an initial claim. Once a run has ever held a task, later idle/null `runs.task_id` periods are not No-claim sessions.

## 5. Data Model

### Seeded built-ins

`pithos init` seeds:

```text
scope: global

agent_kinds:
  pdx       # system actor only; not spawnable, no template, no claims
  pandora
  toil
  greed
  war

capabilities:
  triage
  design
  execute
  escalate

agent_claims:
  pandora -> escalate
  toil    -> triage
  greed   -> design
  war     -> execute

agent_enqueues:
  pdx     -> escalate
  pandora -> triage, design, escalate
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

`pithos run upsert` validates `--agent` against `agent_kinds`. The seeded `pdx` agent kind is a system actor: it is not spawnable, has no manifest/template, has no claim authority, and is excluded from Registry/caps/no-claim timeout. Its global run authors supervisor-created escalation tasks such as kill-induced Interruption escalations.

`pithos task enqueue` validates `--capability` against `capabilities`, enforces capability-specific task rules, and validates `(run.agent_kind, requested_capability)` against `agent_enqueues`. Capability validation failures use `VALIDATION_ERROR` with contextual messages, for example: `<capability> requires scope kind in {repo, worktree} with non-null canonical_path; got <scope-id> kind=<kind>`.

`pithos task claim` validates `(run.agent_kind, requested_capability)` against `agent_claims` in the claim transaction.

A run may hold at most one active task. `pithos task claim` must atomically require `runs.task_id IS NULL` before claiming and setting `runs.task_id`; if the run already points at a task, claim fails loudly with a dedicated validation/user error. A partial unique index on `runs(task_id)` for non-null `task_id` prevents two runs from pointing at the same held task. This keeps `run cleanup` and `run interrupt` correct because both operate on the single held task pointer.

`pithos task claim` also validates the requested scope against the run's registered scope. MVP rule: the requested `--scope` must exactly match `runs.scope_id`. This prevents a run launched in one repo/worktree from claiming and mutating work in another cwd. Broader cross-scope behavior must be represented by enqueueing work into the target scope and spawning a run for that scope.

### Runs

Terminal run statuses include:

```text
ended, failed, cancelled, timed_out
```

`timed_out` is used for non-Pandora No-claim sessions that exceed the 30 second bootstrap timeout without a held task.

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

| Capability | Required scope                                      | Body      | Notes                                 |
| ---------- | --------------------------------------------------- | --------- | ------------------------------------- |
| `triage`   | any                                                 | non-empty | decomposition/routing work            |
| `design`   | any                                                 | non-empty | design/research/alignment work        |
| `execute`  | `repo` or `worktree` with non-null `canonical_path` | non-empty | mutating or repo-local execution work |
| `escalate` | `global`                                            | non-empty | Pandora/Adam attention checkpoint     |

`pithos task supersede` applies the same validation to the replacement task after overrides. Because `escalate` is global-only, all Checkpoint and Interruption escalation tasks live in global scope and reference original task/run/scope details in body or metadata.

## 6. Escalation and Repair

### Planned checkpoint escalation

Checkpoint escalations depend on successful prior work:

```text
triage -> design -> escalate(review design) -> triage(plan execution) -> execute... -> escalate(review result)
```

Because the dependency points at expected successful work, the escalation becomes claimable only after that work is `done`.

### Failure/interruption escalation

Failure or interruption escalations must not depend on failed/cancelled/dead-lettered tasks, because only `done` satisfies dependencies. They are global-scope `escalate` tasks and reference the failed task/run/scope in body or metadata instead.

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

These commands are the public CLI contract for agents and operators. `pdx` does not shell out to this surface; it uses the corresponding `@pithos/pithos` library operations directly.

Clean-break nested command surface:

```text
pithos init [--fresh]

pithos scope upsert --kind <global|repo|worktree> [--path <path>]

pithos run upsert \
  --agent <pdx|pandora|toil|greed|war> \
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
  --capability <triage|design|execute|escalate> \
  --title <text> \
  --stdin \
  [--run <run-id>] \
  [--depends-on <task-id> ...]

# --run defaults from PITHOS_RUN_ID for mutating task commands; if both are present and differ, fail loudly.

pithos task claim \
  --run <run-id> \
  --scope <scope-id> \
  --capability <triage|design|execute|escalate>

# --scope must match the run's registered scope; the run must not already hold a task.

pithos task heartbeat \
  --run <run-id> \
  [--task <task-id> --token <n>]

# Heartbeat records liveness/observability. With --task and --token, it may advance that held task from claimed to running. No hook names, lease extension, or CLI throttling exist in MVP.

pithos task complete <task-id> --run <run-id> --token <n> [--result-file <path>]

pithos task fail <task-id> --run <run-id> --token <n> --reason <text>

pithos task supersede \
  <task-id> \
  [--run <run-id>] \
  --reason <text> \
  [--title <text>] \
  [--scope <scope-id>] \
  [--capability <triage|design|execute|escalate>] \
  --stdin

pithos task cancel <task-id> --run <run-id> --reason <text>

pithos task inspect <task-id>

pithos task artifact add \
  --task <task-id> \
  --run <run-id> \
  --kind <kind> \
  --title <text> \
  [--body-file <path>]

pithos graph inspect (--task <task-id> | --scope <scope-id> | --all) [--flat] [--dump]

pithos events tail [--limit <n>]

pithos briefing [--agent pandora]
```

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

Used for natural lifecycle cleanup after pdx has confirmed the AFK process or HITL tmux target is gone. Callers: AFK exit observation, HITL tmux disappearance, pdx startup cleanup after orphan kill, and pdx close after child sessions are gone.

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

### `pithos task cancel`

Intentional abandon.

- Allowed for `queued`, `failed`, and `dead_letter` tasks.
- Not allowed for `claimed` or `running`; use `pdx run kill <run-id>` / `pdx task kill <task-id>` or `pithos run interrupt`.
- Not allowed for `done`.
- Emits `task.cancelled`.

## 8. pdx Interfaces

Minimal operator/Pandora-facing API:

```text
pdx open [--data-dir <path>] [--interval-seconds <n>] [--max-afk <n>]
pdx close [--data-dir <path>]

pdx daemon status [--data-dir <path>]
pdx daemon logs [--data-dir <path>] [--limit <n> | --all] [--since <when>]

pdx run kill <run-id> --reason <text> [--data-dir <path>]
pdx run transcript <run-id> [--data-dir <path>] [--limit <n>]

pdx task kill <task-id> --reason <text> [--data-dir <path>]
```

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

No `pdx restart` in MVP. Recovery is explicit through Pandora/Adam and graph repair.

On successful `pdx open`, the CLI prints `tmux attach -t pdx--pandora` and exits. It does not auto-attach.

`pdx` may send a content-free wakeup to live Pandora when claimable `escalate` work appears. Transport is `tmux send-keys` to `pdx--pandora` with a marker line followed by Enter:

```text
# wakeup: claimable escalate
```

The marker contains no task body and is not semantic task injection.

HITL tmux naming uses a BEM-ish Pandora-owned convention:

```text
pdx--daemon
pdx--pandora
pdx--<agent>__<scope-slug>--<session-short>
```

AFK agents use the same `logical_name` convention in logs/status even though they do not have tmux sessions.

Supervisor logs are structured JSONL at an internal pdx-controlled path such as `<data-dir>/pdx.jsonl`. Use structured `Effect.log*` output and spans per project rules; do not write unstructured daemon logs. Every supervisor log line includes at least `ts`, `level`, `span`, and `msg`.

## 9. Spawner Interface

Spawner is primarily a library/module used by `pdx`.

Layered library API exported from `@pithos/spawner` package root:

```ts
renderAgent(input): RenderedAgent
launchRenderedAgent(rendered): LaunchResult
launchAgent(input): LaunchResult
renderSessionTranscript(input): string
```

The package root also exports the public service interfaces and intended live implementation used by consumers. Consumers must import `@pithos/spawner`, not sibling package `src/*` internals.

`renderAgent` is pure render/preview: no Pithos mutation, no process launch, no tmux creation. It loads and validates manifest/templates, validates supplied mode against manifest mode, renders the prompt, builds harness argv/env, and generates `claim_command`.

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
- concise per-agent command recipes

Templates do not receive full `pithos --help` by default. Agents get the commands they need for their role; Pandora gets broader investigation/operator recipes.

Spawner renders `claim_command` from manifest claim capability plus launch context, for example:

```sh
pithos task claim --run <run-id> --scope <scope-id> --capability <claim>
```

Pithos still enforces claim authorization and one-active-task-per-run.

Manifest entries repeat claim/enqueue metadata for rendering and consistency checks, even though Pithos seeds enforcement data. They also declare harness runtime tuning; these fields are MVP contract, not compatibility baggage:

```json
{
	"agent": "war",
	"mode": "afk",
	"claims": ["execute"],
	"enqueues": ["escalate"],
	"harness": {
		"kind": "claude",
		"model": "sonnet",
		"system_prompt_mode": "replace",
		"tools": ["Bash", "Read", "Edit", "Write"]
	},
	"includes": ["_common.md"],
	"template": "war.md.tmpl"
}
```

Harness config rules:

- `model` is required and rendered as `--model <model>` for both Claude and Pi.
- `system_prompt_mode` is required. `replace` renders `--system-prompt <prompt>`; `append` renders `--append-system-prompt <prompt>`.
- `tools` is optional. If omitted, no `--tools` flag is rendered and the harness default applies. If present, it must be non-empty and renders as one comma-separated `--tools <a,b,c>` argument. Tool names are not validated by Spawner; they are harness-owned strings and may change without code changes.
- `includes` is optional. Include names must be unique template basenames. Each listed include is loaded as raw text from the templates directory and becomes a template variable keyed by filename, for example `{{_common.md}}`. Includes are not recursively rendered. Unknown template variables fail loudly.

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

Preview output is JSON `RenderedAgent`, including prompt and harness argv/env. Preview performs manifest/template validation only; it does not validate Pithos run/scope state. Because preview renders the exact harness environment, it requires DB context: either `PITHOS_DB` or `PDX_DATA_DIR` from which Spawner derives `<data-dir>/pithos.sqlite`. `PITHOS_BIN` is optional and defaults to `pithos`.

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
pithos task artifact add ...
pithos task complete <task-id> --run <run-id> --token <token>
```

Pithos invariant: a run may hold at most one active task at a time. After completing/failing a task and clearing `runs.task_id`, the same run may claim another task. Agent behavior is convention: Toil/Greed/War normally claim one task and exit/close for context management; Pandora is long-lived and may repeatedly claim `escalate` tasks sequentially.

Per-agent roles and enqueue authority:

- **Pandora** claims `escalate`, discusses with Adam, investigates with Pithos state plus `pdx daemon status`, `pdx daemon logs`, and `pdx run transcript`, and decides whether to supersede/cancel/replan/enqueue follow-up. She may enqueue `triage`, `design`, and `escalate`, but not `execute`; execution goes through Toil.
- **Toil** claims `triage`, decomposes and routes work, and may enqueue `triage`, `design`, `execute`, and checkpoint `escalate` tasks. Toil may supersede/cancel non-held tasks when repairing a broken chain.
- **Greed** claims `design`, produces `design-brief` artifacts, and may enqueue `design`, `triage`, and `escalate` when the HITL design session branches or is ready for follow-up. Greed does not enqueue `execute` in MVP.
- **War** claims `execute`, performs repo/worktree execution, produces `war-completion` artifacts, and may enqueue `escalate` when attention is needed. War does not enqueue further `execute` tasks in MVP.

## 11. Event Vocabulary

Pithos events are durable audit records. Payloads may grow, but these event names and minimum fields are part of the control-plane contract.

| Event                | Keys                               | Minimum payload                                                                                        |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `task.created`       | `task_id`, optional `actor_run_id` | `scope_id`, `capability`, `title`, `depends_on_task_ids`, optional `supersedes_task_id`                |
| `task.claimed`       | `task_id`, `actor_run_id`          | `run_id`, `fencing_token`                                                                              |
| `task.heartbeat`     | `task_id`, `actor_run_id`          | `run_id`, `fencing_token`, `previous_status`, `status`                                                 |
| `run.heartbeat`      | `run_id`                           | `status`                                                                                               |
| `task.completed`     | `task_id`, `actor_run_id`          | `run_id`, `fencing_token`                                                                              |
| `task.failed`        | `task_id`, `actor_run_id`          | `run_id`, `fencing_token`, `reason`                                                                    |
| `task.cancelled`     | `task_id`, `actor_run_id`          | `reason`, optional `superseded_by_task_id`                                                             |
| `task.superseded`    | old `task_id`, `actor_run_id`      | `new_task_id`, `reason`, `retargeted_dependent_task_ids`                                               |
| `task.reclaimed`     | `task_id`, `run_id`                | `previous_run_id`, `reason`, `attempts`, `max_attempts`, `previous_fencing_token`, `new_fencing_token` |
| `task.dead_lettered` | `task_id`, `run_id`                | `previous_run_id`, `reason`, `attempts`, `max_attempts`, `previous_fencing_token`, `new_fencing_token` |
| `task.interrupted`   | `task_id`, `run_id`                | `run_id`, `reason`, `previous_status`, `previous_fencing_token`, `new_fencing_token`                   |
| `run.cleanup`        | `run_id`                           | `reason`, `previous_status`, `status`, optional `task_id`                                              |
| `run.interrupted`    | `run_id`                           | `reason`, `previous_status`, `status`, optional `task_id`                                              |
| `run.timed_out`      | `run_id`                           | `reason`, `previous_status`, `status`                                                                  |

`specs/task-graph.md` defines graph semantics for dependency and supersession payloads; this table is the consolidated event vocabulary for the control-plane rewrite.

## 12. Implementation Locations

| Area                           | Files                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| Pithos library + CLI surface   | `packages/pithos/src/`, `packages/pithos/test/`, `packages/pithos/README.md`              |
| Spawner launcher-only refactor | `packages/spawner/src/`, `packages/spawner/templates/`                                    |
| pdx package                    | `packages/pdx/`                                                                           |
| Docs                           | `README.md`, `packages/pithos/README.md`, `packages/spawner/README.md`, `specs/README.md` |

## 13. Open Questions

- **No-claim post-timeout policy:** After a non-Pandora run times out or dies before its first claim, should pdx immediately allow a fresh run for the same `(agent, scope)`, apply a bounded retry/backoff policy, or create an escalation before retrying? Current MVP behavior should remain minimal and explicit; do not add silent suppression without a specified policy.
