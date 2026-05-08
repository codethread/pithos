# @pithos/pithos agent notes

The `pithos-next` bin. Greenfield control-plane rewrite that lives beside the production `packages/cli` cutover path.

Root rules (`../../AGENTS.md`) apply in full — fail loudly, tagged errors, strict types at IO, structured logs, spans on non-trivial work. This package keeps the new schema and nested CLI surface isolated from the production `pithos` bin until cutover.

## Shape

- Bin: `pithos-next`
- Entrypoint: `src/main.ts` → `@effect/cli` wiring under `src/cli/`
- Nested command surface only: `init`, `scope upsert`, `run upsert|cleanup|interrupt|timeout|inspect`, `task ...`, `graph inspect`, `events tail`, `briefing`
- Storage: SQLite via `better-sqlite3` and `@effect/sql-sqlite-node`
- Default DB path: `~/.pandora/pithos-next.sqlite` unless `PITHOS_DB` is set

## Package constraints

- `packages/cli/` stays untouched; do not break or silently couple this package to the old schema.
- Authorization and capability-scope checks live at the Pithos boundary, not in spawner or callers.
- `runs.task_id` is the single held-task owner pointer. `tasks` must not reintroduce lease columns.
- `PITHOS_RUN_ID` resolution belongs in the CLI argument layer for mutating task commands.
- Output is JSON on stdout except `briefing`, which emits markdown.

## Manual smoke

```sh
pnpm --filter @pithos/pithos start -- --help
pnpm --filter @pithos/pithos start -- init --fresh
pnpm --filter @pithos/pithos start -- scope upsert --kind repo --path "$PWD"
```
