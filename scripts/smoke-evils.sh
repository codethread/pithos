#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPAWNER_BIN="${SPAWNER_BIN:-$ROOT_DIR/packages/spawner/bin/pandora-spawn-dev}"
SMOKE_DIR="${SMOKE_DIR:-$(mktemp -d)/pdx-evils}"
PITHOS_DB="${PITHOS_DB:-$SMOKE_DIR/pithos.sqlite}"

mkdir -p "$SMOKE_DIR"
export PITHOS_DB
# This smoke script renders bundled repo templates. Ignore any interactive-shell
# pdx config so user overlays in ~/.pdx cannot make jq parse Spawner errors.
unset PDX_DATA_DIR

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
