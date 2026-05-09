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
pnpm --filter @pithos/spawner start -- preview --agent war --mode afk --scope scope_repo --run run_demo --session-id session_demo --cwd "$PWD" | jq .
```
