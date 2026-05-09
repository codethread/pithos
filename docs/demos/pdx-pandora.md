# pdx Pandora singleton demo

Replay after `pnpm run build` so `pdx`, `pithos-next`, and `pandora-spawn` are linked from this checkout.

```sh
HOME_DIR=$(mktemp -d)
pdx open --home "$HOME_DIR" --interval-seconds 5
# prints: tmux attach -t pdx--pandora

tmux attach -t pdx--pandora
# In Pandora, enqueue triage work if desired:
# pithos task enqueue --scope global --capability triage --title 'demo triage' --body 'demo body'

pdx status --home "$HOME_DIR" --json | jq '.daemon, .registry, .queue'

tmux kill-session -t pdx--pandora
sleep 6
pdx status --home "$HOME_DIR" --json | jq '.registry.entries[0].runId'
tmux attach -t pdx--pandora

pdx close --home "$HOME_DIR"
pdx logs show --home "$HOME_DIR" --all | jq -c .
```

Expected: `pdx open` starts daemon logging and a live `pdx--pandora` tmux session; after manual tmux kill, reconcile cleans the old run and respawns Pandora with a fresh run id; `pdx close` kills Pandora before cleaning the pdx system run.

Human verification: pending Adam + agent walkthrough.
