# Contributing to `@pithos/pithos`

This package is the greenfield `pithos-next` cutover target.

Root rules (`../../AGENTS.md`) apply in full: fail loudly, strict types at IO, structured logs, tagged errors, transactions for multi-write state changes.

## Build

```sh
pnpm --filter @pithos/pithos build
pnpm --filter @pithos/pithos start -- --help
```

## Tests

```sh
pnpm --filter @pithos/pithos test:unit
pnpm --filter @pithos/pithos test:integration
pnpm --filter @pithos/pithos test
```

## Checklist

1. Keep `packages/cli/` untouched.
2. Keep the nested CLI surface aligned with `specs/control-plane-supervision.md`.
3. Enforce authorization and capability-scope rules in command handlers.
4. Decode CLI args, env vars, DB rows, and files at the IO boundary.
5. Add or update tests for every new invariant.
6. Run `pnpm verify` from repo root before landing changes.
