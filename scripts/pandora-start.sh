#!/usr/bin/env bash
set -euo pipefail

repo_path="${1:-$PWD}"
repo_path="$(cd "$repo_path" && pwd -P)"

pithos init >/dev/null
scope_json="$(pithos scope upsert --kind repo --path "$repo_path")"
scope_id="$(printf '%s' "$scope_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).scope.id))')"

pandora-spawn hooks install >/dev/null
exec pandora-spawn --agent pandora --scope "$scope_id" --cwd "$repo_path"
