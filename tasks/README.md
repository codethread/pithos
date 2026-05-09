# Task index

Machine-readable task dependency map lives in [`index.yml`](./index.yml).

Individual task files describe scope and acceptance only; blockers live in the YAML index.

## MVP follow-up notes

- Re-check generated CLI help before task-012b snapshots. `pithos-next --help` currently renders the nested artifact command as `task task artifact add` in the top-level command summary even though `pithos-next task artifact add --help` and the command path work. Treat as CLI-help polish unless it blocks snapshots.
- Keep verifying global bin links during demo gates. Root `pnpm run build` links `pdx` now; stale global npm links can otherwise point at another checkout and make pdx demos misleading.
- Consider pane-visible pdx daemon logs after MVP basics: structured JSONL remains source of truth, but `pdx--daemon` could tee supervisor log lines to stderr so humans attaching to the daemon tmux window see startup/reconcile/cleanup activity live.
