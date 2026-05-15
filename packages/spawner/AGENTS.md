# @pdx/spawner agent notes

Launcher-only package for rendering and launching Pandora's Box agent harness sessions.

## Shape

- Bin: `pandora-spawn`
- CLI surface: `pandora-spawn preview ...` only
- Library surface: `renderAgent(input)`, `launchRenderedAgent(rendered)`, `launchAgent(input)`, `renderSessionTranscript(input)`, `LiveSpawnerServices`, `makeFakeSpawnerServices`
- Config API: repo-root `templates/` defaults are copied into bundle-owned `<PDX_DATA_DIR>/templates/`; when `PDX_DATA_DIR` is set, render reads that seeded tree with overlay from `<PDX_DATA_DIR>/extensions/templates/`

## Manual test

```sh
pnpm --filter @pdx/spawner start -- preview --agent war --mode afk --scope scope_repo --run run_demo --session-id 123e4567-e89b-12d3-a456-426614174000 --cwd "$PWD" | jq .
```

With built/link bin:

```sh
pnpm run build
pandora-spawn preview --agent war --mode afk --scope scope_repo --run run_demo --session-id 123e4567-e89b-12d3-a456-426614174000 --cwd "$PWD" | jq .
```
