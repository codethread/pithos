# @pithos/spawner contributing

Spawner is launcher-only glue. Keep it limited to manifest validation, prompt rendering, harness argv/env construction, and launch metadata.

## Checks

```sh
pnpm --filter @pithos/spawner typecheck
pnpm --filter @pithos/spawner lint
pnpm --filter @pithos/spawner test
pnpm --filter @pithos/spawner build
```

## Manual preview

```sh
pnpm --filter @pithos/spawner start -- preview --agent war --mode afk --scope scope_repo --run run_demo --session-id 123e4567-e89b-12d3-a456-426614174000 --cwd "$PWD" | jq .
```
