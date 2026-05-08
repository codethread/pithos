# @pithos/spawner agent notes

Launcher-only package for manifests, prompt rendering, harness argv/env construction, and launch mechanics.

## Shape

- Bin: `pandora-spawn`
- Public CLI: `pandora-spawn preview ...`
- Public library API: `renderAgent(input)`, `launchAgent(input)`
- Harnesses: Claude Code and Pi
- No DB writes, run registration, status inspection, message injection, or lifecycle policy

## Design notes

- Fail loudly on invalid manifest JSON, template mismatch, unknown template vars, or mode mismatch.
- Manifest `claims` / `enqueues` must match the seeded Pithos capability matrix for that agent.
- `renderAgent` is pure apart from reading manifest/template files.
- `launchAgent` owns process / tmux launch only; callers own lifecycle decisions.

## Manual test

```sh
packages/pithos/bin/pithos-next init --fresh
PITHOS_BIN=pithos-next pnpm --filter @pithos/spawner start -- preview --agent war --mode afk --scope repo:work/example --run run_PREVIEW --session-id session_PREVIEW --cwd ~/work/example | jq .
```

With built/link bin:

```sh
pnpm run build
packages/pithos/bin/pithos-next init --fresh
PITHOS_BIN=pithos-next pandora-spawn preview --agent pandora --mode hitl --scope global --run run_PREVIEW --session-id session_PREVIEW --cwd ~/.pandora | jq .
```
