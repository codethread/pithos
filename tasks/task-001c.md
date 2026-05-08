# Slice 1c — Task write lifecycle, authorization, fencing

## What to build

Implement the core task mutation path over the architecture from tasks 001a/001b.

Commands in scope:

```text
pithos-next task enqueue \
  --scope <scope-id> \
  --capability <triage|design|execute|escalate> \
  --title <text> \
  (--body <text> | --body-file <path>) \
  [--run <run-id>] \
  [--depends-on <task-id> ...]

pithos-next task claim \
  --run <run-id> \
  --scope <scope-id> \
  --capability <triage|design|execute|escalate>

pithos-next task heartbeat \
  --run <run-id> \
  [--task <task-id> --token <n>]

pithos-next task complete <task-id> --run <run-id> --token <n> [--result-file <path>]
pithos-next task fail <task-id> --run <run-id> --token <n> --reason <text>
pithos-next task artifact add --task <task-id> --run <run-id> --kind <kind> --title <text> [--body-file <path>]
```

Core invariants:

- `task enqueue` resolves `--run` from `PITHOS_RUN_ID` when omitted; explicit/env conflict fails loudly.
- Manual/operator enqueue without a resolved run is not exposed.
- `task enqueue` checks `(run.agent_kind, capability)` in `agent_enqueues`.
- `task claim` checks `(run.agent_kind, capability)` in `agent_claims`.
- `task claim --scope` must equal `runs.scope_id`.
- One-held-task-per-run is atomic: claim requires `runs.task_id IS NULL` inside the transaction.
- Capability scope rules:
  - `escalate` must be global scope.
  - `execute` requires `repo`/`worktree` with non-null `canonical_path`.
- Heartbeat shape is locked:
  - `--task` and `--token` are atomic; supplying only one fails loudly.
  - with both, advance held task `claimed -> running`; idempotent if already `running`.
  - without both, emit pure run liveness event.
- Complete/fail use fenced token updates and clear `runs.task_id` only for the held task.
- Events are written in the same transaction as state mutations.

Dependency support in this slice may be limited to recording validated `--depends-on` edges and preventing claims blocked by non-`done` dependencies. Full graph/supersession/read behavior lands in task 001d.

## Test focus

- Authorization rejections for every seeded claim mismatch.
- Authorization rejections for representative enqueue mismatches, including `pdx` only enqueueing `escalate`.
- One-held-task rejection on second claim by same run.
- Run-scope vs claim-scope mismatch rejection.
- Capability scope rejections: `escalate` non-global; `execute` global/no canonical path.
- Heartbeat task/token atomic rejection and idempotent running advance.
- `PITHOS_RUN_ID` resolution and conflict detection.
- Happy path: enqueue → claim → heartbeat → complete.
- Fenced complete/fail stale token rejection rolls back.

## Defer

- `task inspect`, `graph inspect`, `briefing`, `supersede`, `cancel`.
- Exhaustive event payload assertions beyond minimum fields.
- Run cleanup/interrupt/timeout from task 2.

## Acceptance criteria

- [ ] Task write commands are implemented through importable core functions.
- [ ] Authorization and capability-scope invariants are enforced and tested.
- [ ] One-held-task and fenced token behavior are transactional and tested.
- [ ] `PITHOS_RUN_ID` behavior is tested.
- [ ] Happy-path task round trip succeeds through `pithos-next`.
