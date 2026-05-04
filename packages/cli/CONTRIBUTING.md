# Contributing to `@pithos/cli`

This package is the source of truth for Pithos state. The quality bar is high.

Root-level rules (`../../AGENTS.md`) apply here in full: fail loudly, strict types at IO, structured logs, agent-first observability. This file lists the package-specific build commands and the add-a-command checklist.

## Build

```sh
pnpm --filter @pithos/cli build      # esbuild bundle into bin/pithos
pnpm --filter @pithos/cli start --   # build + run without globally linking, e.g. start -- --help
```

## Tests

Two split suites:

```sh
pnpm --filter @pithos/cli test:unit         # fast, fake services
pnpm --filter @pithos/cli test:integration  # spawns the built bin against a temp DB
pnpm --filter @pithos/cli test              # both
```

- Unit tests use injected fake services (clock, ids, fs, exec, db). They must not touch `~/.pandora/pithos.sqlite` or shell out.
- Integration tests run the built `pithos` against a temp `PITHOS_DB`. They cover end-to-end command shapes, exit codes, and JSON output.

## Quality bar

- **No `any`, no leaked `unknown`.** ESLint rules enforce this. Decode at IO boundaries via `Schema.decodeUnknown`.
- **Tagged errors only.** Use `PithosError` (or a subclass) with a machine-readable `code`. No bare `Error`.
- **Discriminated unions, not optional bags.** If two states cannot coexist, the type must say so.
- **DB writes inside transactions.** If a race is detected mid-transaction, throw to roll back. Never best-effort.
- **Structured logs.** `Effect.log*` with `Effect.annotateLogs`. Wrap non-trivial work in `Effect.withSpan`. No `console.log`.

See `../../AGENTS.md` for canonical examples of each.

## Adding a command — checklist

1. Add command file under `src/commands/<name>.ts`.
2. Add a colocated `<name>.test.ts` with at least:
   - happy path
   - one failure mode (validation, not-found, or stale-token)
   - JSON output shape assertion
3. Wire the command into `src/cli/` so it appears in `pithos --help`.
4. Make sure `--help` for the new command lists examples and the exit codes it can produce.
5. If the command mutates state, add an `events` row entry and verify it shows in `pithos tail` and `pithos briefing` where relevant.
6. If you added a new error code, document it in `--help` and add a row to the exit-code table in `README.md`.
7. Run `pnpm verify` from repo root.
