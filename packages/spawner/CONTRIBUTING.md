# Contributing to `@pithos/spawner`

Read `README.md` first. Root rules in `../../AGENTS.md` still apply.

## Scope

This package is launcher glue only.

Keep it focused on:

- manifest + template loading
- prompt rendering
- harness argv/env construction
- AFK foreground launch
- HITL tmux launch
- preview JSON

Do **not** add:

- Pithos DB mutations
- run registration helpers
- status inspection
- message injection
- kill / reclaim / cleanup policy
- control-plane or daemon logic

## Quality bar

- keep IO boundaries schema-decoded
- fail loudly with `SpawnerError`
- keep `renderAgent` pure apart from reading manifest/template files
- prefer Effect DI for filesystem, command execution, and tmux
- keep tests focused on manifest validation, mode validation, preview shape, and prompt rendering
- use snapshots for intentional rendered-shape changes

## Build

```sh
pnpm --filter @pithos/spawner build
pnpm --filter @pithos/pithos build
packages/pithos/bin/pithos-next init --fresh
PITHOS_BIN=pithos-next pnpm --filter @pithos/spawner start -- preview --agent pandora --mode hitl --scope global --run run_PREVIEW --session-id session_PREVIEW --cwd ~/.pandora | jq .
```

## Tests

```sh
pnpm --filter @pithos/spawner test
pnpm --filter @pithos/spawner exec vitest run --update
```

When argv or prompt text changes intentionally, update the snapshot in the same change.
