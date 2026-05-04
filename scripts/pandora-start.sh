#!/usr/bin/env bash
set -euo pipefail

repo_path="${1:-$PWD}"
repo_path="$(cd "$repo_path" && pwd -P)"

pithos init >/dev/null
scope_json="$(pithos scope upsert --kind repo --path "$repo_path")"
scope_id="$(printf '%s' "$scope_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).scope.id))')"

spawn_json="$(pandora-spawn --agent pandora --scope "$scope_id" --cwd "$repo_path")"
printf '%s\n' "$spawn_json" >&2
tmux_session="$(printf '%s' "$spawn_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).tmux_session))')"

if [ -n "${TMUX:-}" ]; then
  exec tmux switch-client -t "$tmux_session"
else
  exec tmux attach -t "$tmux_session"
fi
