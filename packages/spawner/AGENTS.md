# @pithos/spawner agent notes

Launcher-only package for rendering and launching built-in Pithos agent harness sessions.

## Shape

- Bin: `pandora-spawn`
- CLI surface: `pandora-spawn preview ...` only
- Library surface: `renderAgent(input)`, `launchRenderedAgent(rendered)`, `launchAgent(input)`, `renderSessionTranscript(input)`, `LiveSpawnerServices`, `makeFakeSpawnerServices`
- Config API: locked `templates/agents.json` plus `templates/*.md.tmpl`

## Manual test

```sh
pnpm --filter @pithos/spawner start -- preview --agent war --mode afk --scope scope_repo --run run_demo --session-id 123e4567-e89b-12d3-a456-426614174000 --cwd "$PWD" | jq .
```

With built/link bin:

```sh
pnpm run build
pandora-spawn preview --agent war --mode afk --scope scope_repo --run run_demo --session-id 123e4567-e89b-12d3-a456-426614174000 --cwd "$PWD" | jq .
```
