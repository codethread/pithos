# @pithos/spawner agent notes

Launcher-only package for rendering and launching built-in Pithos agent harness sessions.

## Shape

- Bin: `pandora-spawn`
- CLI surface: `pandora-spawn preview ...` only
- Library surface: `renderAgent(input)` and `launchAgent(input)`
- Config API: locked `templates/agents.json` plus `templates/*.md.tmpl`

## Manual test

```sh
pnpm --filter @pithos/spawner start -- preview --agent war --mode afk --scope scope_repo --run run_demo --session-id session_demo --cwd "$PWD" | jq .
```

With built/link bin:

```sh
pnpm run build
pandora-spawn preview --agent war --mode afk --scope scope_repo --run run_demo --session-id session_demo --cwd "$PWD" | jq .
```
