# @pithos/cli agent notes

The `pithos` bin. SQLite-backed control plane and the **only** writer to the Pithos DB.

Root rules (`../../AGENTS.md`) apply here in full — fail loudly, tagged errors, strict types at IO, structured logs, spans on non-trivial work. This file lists the package-specific shape and constraints.

## Shape

- Bin: `pithos`
- Entrypoint: `src/main.ts` → `@effect/cli` wiring under `src/cli/`
- One file per command under `src/commands/<name>.ts` with a colocated `<name>.test.ts`
- Effect Layer composition lives in `src/layers/`; injected services (clock, ids, fs, exec, db) under `src/services/`
- Storage: `better-sqlite3` via `@effect/sql-sqlite-node`; migrations and row decoders under `src/db/`
- Errors: `PithosError` taxonomy under `src/errors/`; every code is grep-able and surfaces in the exit-code table

## Design notes

- **The DB is the source of truth.** No other package writes to SQLite. Spawner, hooks, and external agents shell out to `pithos`.
- **Mutations run inside transactions.** Validate fencing/preconditions, then write. If a race is detected mid-transaction, throw to roll back — never best-effort.
- **Parse at the IO boundary.** CLI args, DB rows, env vars — all decoded via `Schema.decodeUnknown` before the rest of the code touches them. No `any`, no leaked `unknown`.
- **Output contract is JSON on stdout, structured logs on stderr.** Successful mutations write `{ "ok": true, ... }`; failures write JSON errors. `--help` is the agent-facing contract — improve it instead of writing cheat sheets.
- **Two test suites.** `test:unit` uses fake services and must not touch disk or shell out. `test:integration` runs the built bin against a temp `PITHOS_DB`.

## Manual test

```sh
pnpm --filter @pithos/cli start -- --help
pnpm --filter @pithos/cli start -- init
pnpm --filter @pithos/cli start -- scope upsert --kind repo --path "$PWD"
```

With built/linked bin:

```sh
pnpm run build
pithos --help
```

See `README.md` for the full surface and exit-code table, and `CONTRIBUTING.md` for the quality bar and add-a-command checklist.
