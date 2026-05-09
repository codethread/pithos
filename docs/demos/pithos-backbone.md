# Pithos backbone demo

Status: confirmed by Adam + agent walkthrough on 2026-05-09 via `docs/demos/pithos-backbone.sh`.

Run from repo root after build/link:

```sh
pnpm run build
PITHOS_BIN=pithos-next docs/demos/pithos-backbone.sh
```

The script creates an isolated temporary `PITHOS_DB` and uses only public `pithos-next` CLI commands. It covers:

- `init --fresh`
- global, repo, and worktree scope upserts
- `pdx`, `pandora`, `toil`, `greed`, and `war` run upserts
- authorized `triage`, `design`, `execute`, and `escalate` enqueues
- disallowed claim/enqueue examples and capability/scope rejections
- claim, heartbeat, complete, and fail paths
- `run cleanup`, `run interrupt`, and `run timeout`
- dependency-blocked work becoming claimable after upstream `done`
- failed-task supersede with queued dependent retargeting
- cross-scope supersede rejection when queued dependents would retarget
- queued task cancel
- `events tail`, `graph inspect`, `task inspect`, and `briefing` read surfaces
