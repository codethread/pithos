#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPAWNER_BIN="${SPAWNER_BIN:-$ROOT_DIR/packages/spawner/bin/pandora-spawn}"
SMOKE_DIR="${SMOKE_DIR:-$(mktemp -d)/pdx-evils}"
PITHOS_DB="${PITHOS_DB:-$SMOKE_DIR/pithos.sqlite}"
PDX_DATA_DIR="${PDX_DATA_DIR:-$SMOKE_DIR/pdx-data}"
PDX_USER_DATA_DIR="${PDX_USER_DATA_DIR:-$SMOKE_DIR/pdx-user}"

mkdir -p "$SMOKE_DIR" "$PDX_DATA_DIR/templates" "$PDX_USER_DATA_DIR"
export PITHOS_DB PDX_DATA_DIR PDX_USER_DATA_DIR
cp "$ROOT_DIR/templates/agents.toml" "$PDX_DATA_DIR/agents.toml"
cp -R "$ROOT_DIR/templates/." "$PDX_DATA_DIR/templates/"
# This smoke script renders through an isolated layered config root so previews do
# not read ~/.pdx and can be extended by writing temp user/project layers under
# $PDX_USER_DATA_DIR.

preview_prompt() {
  local agent="$1"
  local mode="$2"
  local session_id="$3"
  local target_file="$SMOKE_DIR/$agent.md"

  "$SPAWNER_BIN" preview \
    --agent "$agent" \
    --mode "$mode" \
    --scope global \
    --run "run_preview_$agent" \
    --session-id "$session_id" \
    --cwd "$ROOT_DIR" \
    | jq -r '.prompt' > "$target_file"

  jq -n \
    --arg name "$agent" \
    --arg mode "$mode" \
    --arg path "$target_file" \
    '{name: $name, mode: $mode, path: $path}'
}

printf '[\n'
first=1
while IFS='|' read -r agent mode session_id; do
  if [[ "$first" -eq 0 ]]; then
    printf ',\n'
  fi
  first=0
  preview_prompt "$agent" "$mode" "$session_id"
done <<'EOF'
pandora|hitl|00000000-0000-4000-8000-000000000001
envy|afk|00000000-0000-4000-8000-000000000002
toil|afk|00000000-0000-4000-8000-000000000003
greed|hitl|00000000-0000-4000-8000-000000000004
war|afk|00000000-0000-4000-8000-000000000005
EOF
printf '\n]\n'
