# Contributing to `@pithos/pdx`

Read `README.md` first. Root rules in `../../AGENTS.md` still apply.

## Scope

This package owns local supervision only.

Keep it focused on:

- daemon lifecycle
- tmux ownership
- supervisor log writing
- operator status / logs access
- local registry and control-plane IPC

Do **not** add:

- direct SQLite writes
- harness prompt rendering
- spawner lifecycle policy
- task-graph invariants

## Build

```sh
pnpm --filter @pithos/pdx build
```

## Tests

```sh
pnpm --filter @pithos/pdx test
```
