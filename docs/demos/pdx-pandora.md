# pdx Pandora singleton demo

Replay after `pnpm run build` so `pdx`, `pithos`, and `pandora-spawn` are linked from this checkout.

```sh
DATA_DIR=$(mktemp -d)
pdx open --data-dir "$DATA_DIR" --interval-seconds 5
# prints: tmux attach -t pdx--pandora

tmux attach -t pdx--pandora
# In Pandora, enqueue triage work if desired:
# printf '%s\n' 'demo body' | pithos task enqueue --scope global --capability triage --title 'demo triage' --stdin

pdx daemon status --data-dir "$DATA_DIR" | jq '.daemon, .registry, .queue'

tmux kill-session -t pdx--pandora
sleep 6
pdx daemon status --data-dir "$DATA_DIR" | jq '.registry.entries[0].runId'
tmux attach -t pdx--pandora

pdx close --data-dir "$DATA_DIR"
pdx daemon logs --data-dir "$DATA_DIR" --all | jq -c .
```

Expected: `pdx open` starts daemon logging and a live `pdx--pandora` tmux session; after manual tmux kill, reconcile cleans the old run and respawns Pandora with a fresh run id; `pdx close` kills Pandora before cleaning the pdx system run.

Human verification: pending Adam + agent walkthrough.
