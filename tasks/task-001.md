# Slice 1 — Pithos foundation epic

## Status

This slice is **not implementable as one honest unit**. It is now a parent epic for the smaller `task-001*` slices below.

## Why it was split

The first attempt hit the expected blocker: the original slice combined too many architectural and behavioral contracts at once:

- new package architecture and an importable Pithos core library for `pdx`
- fresh schema, seed data, and typed DB row decoding
- nested `@effect/cli` command surface
- task/run authorization and capability-scope invariants
- task write lifecycle and fencing
- graph inspection, supersession, briefing, events, and artifacts
- broad unit/integration test matrix

The in-progress work also clarified a non-negotiable direction: `packages/pithos/` must expose reusable core functions/services, with the public CLI only a thin `@effect/cli` wrapper. Do not grow a monolithic argv parser or direct IO-heavy command file.

## Replacement slices

Implement these in order:

1. [task-001a — Pithos core architecture, config, schema, seeds](./task-001a.md)
2. [task-001b — Nested CLI shell + scope/run foundations](./task-001b.md)
3. [task-001c — Task write lifecycle, authorization, fencing](./task-001c.md)
4. [task-001d — Graph, supersession, read surfaces](./task-001d.md)
5. [task-001e — Foundation contract hardening + acceptance](./task-001e.md)

Downstream tasks that previously blocked on task 1 should block on `task-001e` unless they explicitly need only an earlier foundation milestone.

## Original task contract retained by the split

The split still must deliver the original task 1 outcome:

- New `packages/pithos/` workspace package builds; old `packages/cli/` and current `pithos` bin remain untouched until cutover.
- `pithos-next init --fresh` creates the fresh target schema and seeded built-ins.
- Nested command surface exists, with no flat aliases and no removed lifecycle commands (`sweep`, `run end`, `run finish`).
- Pithos enforces claim/enqueue authorization, one-held-task-per-run, run-scope claim matching, capability scope rules, heartbeat atomicity, and `PITHOS_RUN_ID` conflict detection.
- Outputs for inspect/graph/briefing/events satisfy the spec minimum contracts.
- Tests cover behavior that schema cannot express.

## Canonical implementation primitives

These primitives apply to all child slices:

- **Transactions:** multi-statement mutations must be one transaction. Any detected race throws/fails to roll back; never best-effort.
- **Fenced UPDATE:** capture preconditions, update with token/status/owner predicates, and treat zero affected rows as `STALE_TOKEN_RACE` or equivalent tagged failure.
- **One-held-task atomic claim:** `UPDATE runs SET task_id = ? WHERE id = ? AND task_id IS NULL`; zero changes is a loud validation/user error. Partial unique index on `runs(task_id) WHERE task_id IS NOT NULL` remains the second-line defence.
- **Row decoding at IO boundary:** DB rows, env, CLI args, file bodies, and subprocess output are parsed into typed structures before domain logic. No leaked `unknown`/`any`.
- **Importable core first:** command handlers call core functions; `@effect/cli` parses and dispatches only.
- **Discriminated unions:** parsed command inputs are tagged variants, not wide optional bags.
