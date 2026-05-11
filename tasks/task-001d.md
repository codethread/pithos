# Slice 1d — Graph, supersession, read surfaces

## What to build

Complete the graph-aware task surfaces using the schema and write-path foundations from tasks 001a-001c.

Commands in scope:

```text
pithos task inspect <task-id> [--json]
pithos task supersede <task-id> --run <run-id> --reason <text> [--title <text>] [--scope <scope-id>] [--capability <triage|design|execute|escalate>] --stdin
pithos task cancel <task-id> --run <run-id> --reason <text>
pithos graph inspect (--task <task-id> | --scope <scope-id> | --all) [--json]
pithos briefing [--agent pandora] [--json]
```

Graph semantics:

- Dependencies are satisfied only by upstream task status `done`.
- Claimability is computed dynamically; do not add a persisted `blocked` status.
- Enqueue rejects duplicate dependency IDs and dependency IDs that have already been superseded.
- The graph must remain acyclic after enqueue and supersede transactions.

Supersede contract:

- Allowed old task states: `queued`, `failed`, `dead_letter`, `cancelled`.
- Reject `claimed` or `running`; use `pdx kill` / `run interrupt` first.
- Reject if the old task was already superseded.
- Copy upstream dependencies to the replacement.
- Retarget direct queued dependents to the replacement.
- Ignore direct cancelled dependents.
- Reject if any direct dependent is `claimed`, `running`, `done`, `failed`, or `dead_letter`.
- If replacement scope changes and queued direct dependents would be retargeted, fail loudly.
- If old task was `queued`, mark it `cancelled` in the same transaction.
- Emit `task.created`, `task.cancelled` when applicable, and `task.superseded` with required payload fields.

Cancel contract:

- Allowed for `queued`, `failed`, and `dead_letter` tasks.
- Reject `claimed`, `running`, and `done`.
- Emit `task.cancelled`.

Read surfaces:

- `task inspect` renders an agent-readable task handoff by default; `--json` returns task details, artifacts, direct dependencies, direct dependents, unresolved blockers, and supersession links.
- `graph inspect` renders a readable dependency tree by default; `--json` returns closed graph JSON for `--task`, `--scope`, or `--all` selectors; selectors are mutually exclusive.
- `briefing` renders readable ready/blocked work by default; `--json` returns ready and blocked work with blocker summaries.

## Test focus

- Cross-scope dependency claim blocking and unblocking after upstream completion.
- Enqueue duplicate dependency and superseded dependency rejection.
- Cycle detection for enqueue and supersede.
- Supersede precondition matrix and dependent retarget behavior.
- Scope-change rejection when queued dependents would be retargeted.
- Cancel precondition matrix.
- `task inspect` minimum output contract and deterministic ordering.
- `graph inspect` closure: every emitted edge references present nodes.
- `briefing` ready vs blocked rendering/JSON contract.

## Defer

- Run cleanup/interrupt/timeout from task 2.
- Performance optimization for large graphs.
- Exhaustive flat-output snapshots beyond representative contracts.

## Acceptance criteria

- [ ] Graph and supersession semantics match `specs/task-graph.md` plus supervision spec overrides.
- [ ] Read surfaces return spec minimum keys.
- [ ] Supersede/cancel are transactional and evented.
- [ ] Tests cover dependency, supersession, inspect, graph, and briefing behavior.
