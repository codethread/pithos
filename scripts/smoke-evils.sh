#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATES_DIR="$ROOT_DIR/templates"
SMOKE_DIR="${SMOKE_DIR:-$(mktemp -d)/pdx-evils}"

mkdir -p "$SMOKE_DIR"

printf '[\n'
first=1
for evil in pandora envy toil greed war; do
  source_file="$TEMPLATES_DIR/$evil.md"
  target_file="$SMOKE_DIR/$evil.md"

  cp "$source_file" "$target_file"

  if [[ "$first" -eq 0 ]]; then
    printf ',\n'
  fi
  first=0

  jq -n \
    --arg name "$evil" \
    --arg path "$target_file" \
    '{name: $name, path: $path}'
done
printf '\n]\n'
