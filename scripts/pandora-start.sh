#!/usr/bin/env bash
set -euo pipefail

pithos_home="${PITHOS_HOME:-$HOME/.pandora}"
mkdir -p "$pithos_home"

pithos init >/dev/null

spawn_json="$(pandora-spawn --agent pandora --scope global --cwd "$pithos_home")"
printf '%s\n' "$spawn_json" >&2
tmux_session="$(printf '%s' "$spawn_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).tmux_session))')"

if [ -n "${TMUX:-}" ]; then
  exec tmux switch-client -t "$tmux_session"
else
  exec tmux attach -t "$tmux_session"
fi
