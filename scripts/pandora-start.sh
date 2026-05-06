#!/usr/bin/env bash
set -euo pipefail

fresh=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh) fresh=true; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Check for an existing pithos-pandora-* session.
# --fresh kills it so the clean-reset path can proceed; otherwise attach.
existing="$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^pithos-pandora-' | head -n1 || true)"
if [[ -n "$existing" ]]; then
  if $fresh; then
    tmux kill-session -t "$existing"
  elif [[ -n "${TMUX:-}" ]]; then
    exec tmux switch-client -t "$existing"
  else
    exec tmux attach -t "$existing"
  fi
fi

pithos_home="${PITHOS_HOME:-$HOME/.pandora}"

if $fresh; then
  rm -rf "$pithos_home"
fi

mkdir -p "$pithos_home"

pithos init >/dev/null

spawn_json="$(pandora-spawn --agent pandora --scope global --cwd "$pithos_home")"
printf '%s\n' "$spawn_json" >&2
tmux_session="$(printf '%s' "$spawn_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).tmux_session))')"

if [[ -n "${TMUX:-}" ]]; then
  exec tmux switch-client -t "$tmux_session"
else
  exec tmux attach -t "$tmux_session"
fi
