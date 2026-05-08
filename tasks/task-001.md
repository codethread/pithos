# Slice 1 — Pithos foundation: schema, seeds, nested CLI, authorization

## What to build

Greenfield `packages/pithos/` workspace package. Old `packages/cli/` stays untouched and continues to ship the production `pithos` bin until cutover; the new package exposes a temporary bin (e.g. `pithos-next`) for development.

Single fresh-DB migration covering the full target schema:

- `scopes`, `runs` (with `mode TEXT NOT NULL CHECK (mode IN ('afk','hitl'))` and terminal status `timed_out`), `tasks` (no `lease_until`, no `lease_owner_run_id`)
- `task_dependencies`, `task_supersessions` (graph)
- `agent_kinds`, `capabilities`, `agent_claims`, `agent_enqueues` (authorization)
- `events`, `artifacts`
- Partial unique index on `runs(task_id)` where `task_id IS NOT NULL`

Seed per spec §5: agent_kinds (`pdx`, `pandora`, `toil`, `greed`, `war`); capabilities (`triage`, `design`, `execute`, `escalate`); claim and enqueue rules. `pdx` has no claims and only enqueues `escalate`.

Nested CLI surface per spec §7:

- `pithos init [--fresh]`, `pithos scope upsert`, `pithos run upsert`
- `pithos task enqueue|claim|heartbeat|complete|fail|supersede|cancel|inspect`, `pithos task artifact add`
- `pithos graph inspect`, `pithos events tail`, `pithos briefing`

No flat aliases. No `sweep`, no `run end`, no `run finish`.

Authorization and invariants enforced at the Pithos boundary:

- claim/enqueue check `(agent_kind, capability)` against seeded rules
- one-held-task-per-run: claim atomically requires `runs.task_id IS NULL`
- claim `--scope` must equal `runs.scope_id`
- capability scope rules: `escalate` must be `global`; `execute` requires `repo`/`worktree` with non-null `canonical_path`
- `PITHOS_RUN_ID` env-var resolves `--run` for mutating task commands; conflict between env and explicit flag fails loud

Heartbeat surface per locked decision:

```text
pithos task heartbeat \
  --run <run-id> \
  [--task <task-id> --token <n>]
```

`--task` and `--token` are atomic — supplying one without the other fails loud. With both, advance held task `claimed → running` (idempotent if already `running`); without, pure liveness event. No `--hook`, no `--throttle-seconds`.

## Test focus

Contracts that schema cannot express:

- Authorization rejections for every `(agent_kind, capability)` mismatch on claim and enqueue
- One-held-task rejection on second claim by same run
- Run-scope vs claim-scope mismatch rejection
- Capability scope rule rejections (escalate non-global; execute on global)
- Heartbeat `--task`/`--token` atomic rejection; idempotent already-running advance
- `PITHOS_RUN_ID` conflict detection
- Happy-path enqueue → claim → heartbeat → complete round-trip

Defer: exhaustive CLI argument-parsing snapshots, full event-payload field assertions beyond required minimums.

## Implementation primitives

Canonical SQL/CLI patterns — referenced by tasks 002/003.

- **Transactions:** wrap multi-statement mutation in `sql.withTransaction(Effect.gen(...))`. Throwing inside the closure rolls back.
- **Fenced UPDATE:** capture preconditions, run `` sql`UPDATE ... WHERE token = ?`.raw `` to get `{ changes }`. If `changes === 0` → `Effect.fail(new PithosError({ code: "STALE_TOKEN_RACE", ... }))` to roll back the whole transaction. Project rule 2 (DB integrity) — never best-effort.
- **One-held-task atomic claim:** inside `withTransaction`, UPDATE `runs SET task_id = ? WHERE id = ? AND task_id IS NULL`. Zero changes → fail loud with a dedicated validation error. The partial unique index on `runs(task_id) WHERE task_id IS NOT NULL` is the second-line defence.
- **Partial unique index:** Effect SQL has no DDL builder for partial indexes — use `` sql.unsafe(`CREATE UNIQUE INDEX idx_runs_task_id ON runs(task_id) WHERE task_id IS NOT NULL`) `` in the migration.
- **Row decoding at IO boundary:** `SqlSchema.findAll | findOne | single` with a `Schema.Struct(...)`. Anything crossing IO is parsed before downstream code touches it (CLAUDE.md rule 3).
- **CLI argument parsing:** `@effect/cli` is in the workspace and supports nested subcommands via `Command.withSubcommands(...)`. `PITHOS_RUN_ID` env-var resolution happens at the command-arg layer; conflict between env and `--run` flag fails with `VALIDATION_ERROR`.
- **Discriminated unions for parsed args:** parsed CLI args are tagged variants, never wide optional bags (CLAUDE.md rule 3).

**Blocked note:** This slice needs to be broken down smaller before continuing: it combines package architecture, schema/seeding, nested CLI, authorization invariants, graph/read surfaces, and a broad test matrix into one unit. The in-progress work established the required direction that Pithos must expose an importable core library for pdx with the public CLI as an @effect/cli wrapper, but the full slice contract remains too large to complete honestly as a single unit.

## Acceptance criteria

- [ ] New `packages/pithos/` workspace builds; tests green
- [ ] `pithos-next init --fresh` creates schema and seeds, idempotent on re-run without `--fresh`
- [ ] All commands in spec §7 present; reject invalid input loudly via `PithosError` with machine-readable codes
- [ ] Command outputs (`run inspect`, `task inspect`, `graph inspect`, `briefing`) match spec §7 minimum-key contracts
- [ ] Authorization, one-held-task, scope-match, capability-scope rules enforced and tested
- [ ] Heartbeat shape matches spec; atomic `--task`/`--token` enforced
- [ ] `PITHOS_RUN_ID` resolution and conflict detection tested
- [ ] Old `packages/cli/` and existing `pithos` bin unchanged and still functional against old DB
