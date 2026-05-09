# Spawner preview smoke

Use this prompt only to verify the Slice 4 launcher-only Spawner surface.

## Goal

Confirm `pandora-spawn preview` renders all built-in spawnable agents without touching Pithos state or launching a harness.

## Commands

```sh
for spec in \
  'pandora hitl escalate' \
  'toil afk triage' \
  'greed hitl design' \
  'war afk execute'
do
  set -- $spec
  agent="$1"
  mode="$2"
  capability="$3"
  pandora-spawn preview \
    --agent "$agent" \
    --mode "$mode" \
    --scope scope_smoke \
    --run run_smoke_${agent} \
    --session-id session_smoke_${agent} \
    --cwd "$PWD" \
    | jq -e \
      --arg agent "$agent" \
      --arg mode "$mode" \
      --arg capability "$capability" \
      '.agent == $agent and .mode == $mode and (.prompt | contains("--capability " + $capability))'
done
```

## Expected

- all four preview invocations return JSON
- no tmux session is created
- no Pithos run/task state is mutated
- rendered claim commands use `pithos` unless `PITHOS_BIN` is set
