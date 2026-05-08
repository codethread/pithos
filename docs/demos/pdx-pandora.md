# pdx Pandora singleton demo

Replayable CLI walkthrough for slice 6.

## Prereqs

- `pnpm install`
- `tmux`
- run from repo root
- `pi` on PATH, or use the fake harness stub below for local verification

## Optional fake `pi` harness

Use this if you want to replay the daemon/singleton flow without a real Pi install.

```bash
FAKE_BIN=$(mktemp -d)
cat >"$FAKE_BIN/pi" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
session=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session) session="$2"; shift 2 ;;
    --extension|--system-prompt) shift 2 ;;
    *) shift ;;
  esac
done
if [[ -n "$session" ]]; then
  mkdir -p "$(dirname "$session")"
  printf '{"ts":"%s","level":"info","msg":"fake pi started"}\n' "$(date -u +%FT%TZ)" >> "$session"
fi
trap 'exit 0' TERM INT
while true; do sleep 1; done
EOF
chmod +x "$FAKE_BIN/pi"
export PATH="$FAKE_BIN:$PATH"
```

## Demo

```bash
set -euo pipefail

ROOT=$(pwd)
DEMO_HOME=$(mktemp -d)
DB_PATH="$DEMO_HOME/pithos-next.sqlite"

export PITHOS_DB="$DB_PATH"
export PITHOS_LOG_LEVEL=none

pnpm --filter @pithos/pithos build >/dev/null
pnpm --filter @pithos/spawner build >/dev/null
pnpm --filter @pithos/pdx build >/dev/null

PITHOS_BIN="$ROOT/packages/pithos/bin/pithos-next"
PDX_BIN="$ROOT/packages/pdx/bin/pdx"

json() {
  "$@" | tee /dev/stderr | jq -r .
}

echo "== open pdx; daemon + Pandora come up =="
OPEN_OUT=$($PDX_BIN open --home "$DEMO_HOME" --interval-seconds 1)
printf '%s\n' "$OPEN_OUT"
[ "$OPEN_OUT" = "tmux attach -t pdx--pandora" ]

echo "== status shows live Pandora registry entry =="
json "$PDX_BIN" status --home "$DEMO_HOME" --json >/dev/null
PANDORA_RUN=$($PDX_BIN status --home "$DEMO_HOME" --json | jq -r '.registry[] | select(.agent == "pandora") | .runId')

echo "== attach and confirm Pandora session exists =="
tmux has-session -t pdx--pandora

echo "== enqueue a global escalation; slice 6 does not auto-claim it yet =="
ESCALATE_TASK=$($PITHOS_BIN task enqueue \
  --run "$PANDORA_RUN" \
  --scope global \
  --capability escalate \
  --title "Review demo status" \
  --body "Pandora should notice this queued escalation later" | jq -r '.task.id')
printf 'task=%s\n' "$ESCALATE_TASK"
json "$PDX_BIN" status --home "$DEMO_HOME" --json >/dev/null
$PDX_BIN status --home "$DEMO_HOME" --json | jq -r '.queue.claimable[] | select(.scopeId == "global" and .capability == "escalate") | .count'

echo "== kill Pandora's tmux session; reconcile respawns within one tick =="
OLD_RUN="$PANDORA_RUN"
tmux kill-session -t pdx--pandora
sleep 2
json "$PDX_BIN" status --home "$DEMO_HOME" --json >/dev/null
NEW_RUN=$($PDX_BIN status --home "$DEMO_HOME" --json | jq -r '.registry[] | select(.agent == "pandora") | .runId')
[ "$NEW_RUN" != "$OLD_RUN" ]
tmux has-session -t pdx--pandora

echo "== inspect supervisor log =="
$PDX_BIN logs show --home "$DEMO_HOME" --all | tee /dev/stderr >/dev/null

echo "== close pdx; Pandora and daemon go away; pdx system run cleans up last =="
$PDX_BIN close --home "$DEMO_HOME"
json "$PDX_BIN" status --home "$DEMO_HOME" --json >/dev/null

echo "demo home: $DEMO_HOME"
```
