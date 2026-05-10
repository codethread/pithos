# @pithos/pdx contributing

## Validate

```sh
pnpm --filter @pithos/pdx typecheck
pnpm --filter @pithos/pdx lint
pnpm --filter @pithos/pdx test
```

Before stable CLI/help changes, also inspect:

```sh
pnpm --filter @pithos/pdx start --help
pnpm --filter @pithos/pdx start -- daemon --help
pnpm --filter @pithos/pdx start -- run --help
pnpm --filter @pithos/pdx start -- task --help
```

## Boundaries

- Pithos owns durable DB invariants and run/task transitions.
- Spawner owns harness rendering, launch argv/env, and transcript parsing.
- pdx owns local supervision, Registry state, operator kill, daemon status, and supervisor logs.

Runtime process/filesystem/tmux operations go through pdx service interfaces. Domain/controller code should not import sibling package internals; consume package-root APIs such as `@pithos/pithos` and `@pithos/spawner`.
