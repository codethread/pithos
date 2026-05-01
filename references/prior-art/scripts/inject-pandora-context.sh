#!/usr/bin/env bash
# Injects pandora workspace files + bin --help into Claude context at session start.
# when working on this, you can easily verify final output with
# nu -c "./scripts/inject-pandora-context.sh | jq '.hookSpecificOutput.additionalContext' | split column '\n' | transpose | get column1" to present to Adam

VAULT="$PWD"

read_file() {
  local tag="$1"
  local label="$2"
  local path="$VAULT/$3"
  [[ -f "$path" ]] || return
  echo "<$tag path=\"$label\">"
  cat "$path"
  echo "</$tag>"
  echo ""
}

read_help() {
  local bin="$1"
  local path="$VAULT/pandora/bin/$bin"
  [[ -x "$path" ]] || return
  echo "<command-help command=\"pandora/bin/$bin --help\">"
  "$path" --help 2>&1 || true
  echo "</command-help>"
  echo ""
}

CONTEXT=$(
  read_file "pandora-readme" "pandora/README.md"      "pandora/README.md"
  read_file "pandora-inbox"  "pandora/tasks/inbox.md" "pandora/tasks/inbox.md"
  read_file "pandora-wip"    "pandora/tasks/wip.md"   "pandora/tasks/wip.md"
  read_help "delegate"
  read_help "status"
  read_help "envy"
  read_help "done"
  read_help "watch-inbox"
)

jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
