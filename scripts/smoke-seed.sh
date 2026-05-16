#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PITHOS_BIN="${PITHOS_BIN:-$ROOT_DIR/packages/pithos/bin/pithos-dev}"
PDX_DATA_DIR="${PDX_DATA_DIR:-$(mktemp -d)/pdx}"
PITHOS_DB="${PITHOS_DB:-$PDX_DATA_DIR/pithos.sqlite}"
REPO_DIR="$PDX_DATA_DIR/repo-smoke"

export PDX_DATA_DIR PITHOS_DB

mkdir -p "$PDX_DATA_DIR" "$REPO_DIR"

printf 'Smoke data dir: %s\n' "$PDX_DATA_DIR"
printf 'Pithos DB: %s\n\n' "$PITHOS_DB"

run_json() {
  printf '\n$ %s\n' "$*"
  "$@" | jq .
}

run_text() {
  printf '\n$ %s\n' "$*"
  "$@"
}

run_json_stdin() {
  local input="$1"
  shift
  printf '\n$ printf %%s %q | %s\n' "$input" "$*"
  printf '%s' "$input" | "$@" | jq .
}

capture_json() {
  local output_file="$1"
  shift
  printf '\n$ %s\n' "$*"
  "$@" | tee "$output_file" | jq .
}

capture_json_stdin() {
  local output_file="$1"
  local input="$2"
  shift 2
  printf '\n$ printf %%s %q | %s\n' "$input" "$*"
  printf '%s' "$input" | "$@" | tee "$output_file" | jq .
}

json_value() {
  local file="$1"
  local filter="$2"
  jq -r "$filter" "$file"
}

run_json "$PITHOS_BIN" init --fresh

capture_json "$PDX_DATA_DIR/scope.json" \
  "$PITHOS_BIN" scope upsert \
    --kind repo \
    --path "$REPO_DIR" \
    --description 'smoke repo scope for graph inspect'
REPO_SCOPE="$(json_value "$PDX_DATA_DIR/scope.json" '.scope.id')"

run_json "$PITHOS_BIN" run upsert \
  --run run_pandora-smoke \
  --agent pandora \
  --mode hitl \
  --scope "$REPO_SCOPE" \
  --cwd "$REPO_DIR" \
  --harness-kind system \
  --session-log-path "$PDX_DATA_DIR/pandora.jsonl" \
  --session-id smoke-pandora

run_json "$PITHOS_BIN" run upsert \
  --run run_pandora-global-smoke \
  --agent pandora \
  --mode hitl \
  --scope global \
  --cwd "$ROOT_DIR" \
  --harness-kind system \
  --session-log-path "$PDX_DATA_DIR/pandora-global.jsonl" \
  --session-id smoke-pandora-global

run_json "$PITHOS_BIN" run upsert \
  --run run_toil-smoke \
  --agent toil \
  --mode afk \
  --scope "$REPO_SCOPE" \
  --cwd "$REPO_DIR" \
  --harness-kind system \
  --session-log-path "$PDX_DATA_DIR/toil.jsonl" \
  --session-id smoke-toil

run_json "$PITHOS_BIN" run upsert \
  --run run_greed-smoke \
  --agent greed \
  --mode hitl \
  --scope "$REPO_SCOPE" \
  --cwd "$REPO_DIR" \
  --harness-kind system \
  --session-log-path "$PDX_DATA_DIR/greed.jsonl" \
  --session-id smoke-greed

run_json "$PITHOS_BIN" run upsert \
  --run run_war-smoke \
  --agent war \
  --mode afk \
  --scope "$REPO_SCOPE" \
  --cwd "$REPO_DIR" \
  --harness-kind system \
  --session-log-path "$PDX_DATA_DIR/war.jsonl" \
  --session-id smoke-war

capture_json_stdin "$PDX_DATA_DIR/task-triage.json" $'Classify the repo smoke feature and decide whether design is needed.\n' \
  "$PITHOS_BIN" task enqueue \
    --run run_pandora-smoke \
    --scope "$REPO_SCOPE" \
    --capability triage \
    --title 'Smoke triage root' \
    --chain none \
    --stdin
TRIAGE_TASK="$(json_value "$PDX_DATA_DIR/task-triage.json" '.task.id')"

capture_json "$PDX_DATA_DIR/claim-triage.json" \
  "$PITHOS_BIN" task claim \
    --run run_toil-smoke \
    --scope "$REPO_SCOPE" \
    --capability triage
TRIAGE_TOKEN="$(json_value "$PDX_DATA_DIR/claim-triage.json" '.task.token')"

capture_json_stdin "$PDX_DATA_DIR/task-design.json" $'Draft the design for the smoke feature after triage completes.\n' \
  "$PITHOS_BIN" task enqueue \
    --run run_toil-smoke \
    --scope "$REPO_SCOPE" \
    --capability design \
    --title 'Smoke design follow-up' \
    --stdin
DESIGN_TASK="$(json_value "$PDX_DATA_DIR/task-design.json" '.task.id')"

capture_json_stdin "$PDX_DATA_DIR/complete-triage.json" $'{"summary":"triage routed to design"}\n' \
  "$PITHOS_BIN" task complete "$TRIAGE_TASK" \
    --run run_toil-smoke \
    --token "$TRIAGE_TOKEN" \
    --stdin

capture_json "$PDX_DATA_DIR/claim-design.json" \
  "$PITHOS_BIN" task claim \
    --run run_greed-smoke \
    --scope "$REPO_SCOPE" \
    --capability design
DESIGN_TOKEN="$(json_value "$PDX_DATA_DIR/claim-design.json" '.task.token')"

capture_json_stdin "$PDX_DATA_DIR/task-execute-api.json" $'Implement the API side of the smoke feature after design is approved.\n' \
  "$PITHOS_BIN" task enqueue \
    --run run_toil-smoke \
    --scope "$REPO_SCOPE" \
    --capability execute \
    --title 'Smoke execute API' \
    --chain none \
    --depends-on "$DESIGN_TASK" \
    --stdin
EXEC_API_TASK="$(json_value "$PDX_DATA_DIR/task-execute-api.json" '.task.id')"

capture_json_stdin "$PDX_DATA_DIR/task-execute-docs.json" $'Update smoke docs after the design is done.\n' \
  "$PITHOS_BIN" task enqueue \
    --run run_toil-smoke \
    --scope "$REPO_SCOPE" \
    --capability execute \
    --title 'Smoke execute docs' \
    --chain none \
    --depends-on "$DESIGN_TASK" \
    --stdin
EXEC_DOCS_TASK="$(json_value "$PDX_DATA_DIR/task-execute-docs.json" '.task.id')"

capture_json_stdin "$PDX_DATA_DIR/task-escalation.json" $'Please approve the smoke design direction before execution proceeds.\n' \
  "$PITHOS_BIN" task enqueue \
    --run run_greed-smoke \
    --scope global \
    --capability escalate \
    --title 'Smoke design approval' \
    --stdin
ESCALATION_TASK="$(json_value "$PDX_DATA_DIR/task-escalation.json" '.task.id')"

capture_json "$PDX_DATA_DIR/claim-escalation.json" \
  "$PITHOS_BIN" task claim \
    --run run_pandora-global-smoke \
    --scope global \
    --capability escalate
ESCALATION_TOKEN="$(json_value "$PDX_DATA_DIR/claim-escalation.json" '.task.token')"

run_json "$PITHOS_BIN" graph inspect --task "$DESIGN_TASK" --json
run_text "$PITHOS_BIN" graph inspect --task "$DESIGN_TASK"

capture_json_stdin "$PDX_DATA_DIR/complete-design.json" $'{"summary":"design approved for smoke execution"}\n' \
  "$PITHOS_BIN" task complete "$DESIGN_TASK" \
    --run run_greed-smoke \
    --token "$DESIGN_TOKEN" \
    --stdin

capture_json_stdin "$PDX_DATA_DIR/task-approved-handoff.json" $'Route the approved design into final smoke verification.\n' \
  "$PITHOS_BIN" task enqueue \
    --run run_pandora-global-smoke \
    --scope "$REPO_SCOPE" \
    --capability triage \
    --title 'Smoke approved handoff' \
    --stdin
HANDOFF_TASK="$(json_value "$PDX_DATA_DIR/task-approved-handoff.json" '.task.id')"

capture_json_stdin "$PDX_DATA_DIR/complete-escalation.json" $'{"summary":"approval recorded and handoff queued"}\n' \
  "$PITHOS_BIN" task complete "$ESCALATION_TASK" \
    --run run_pandora-global-smoke \
    --token "$ESCALATION_TOKEN" \
    --stdin

capture_json "$PDX_DATA_DIR/claim-execute.json" \
  "$PITHOS_BIN" task claim \
    --run run_war-smoke \
    --scope "$REPO_SCOPE" \
    --capability execute
EXEC_TOKEN="$(json_value "$PDX_DATA_DIR/claim-execute.json" '.task.token')"
CLAIMED_EXEC_TASK="$(json_value "$PDX_DATA_DIR/claim-execute.json" '.task.id')"

capture_json_stdin "$PDX_DATA_DIR/complete-execute.json" $'{"summary":"one execute task completed"}\n' \
  "$PITHOS_BIN" task complete "$CLAIMED_EXEC_TASK" \
    --run run_war-smoke \
    --token "$EXEC_TOKEN" \
    --stdin

capture_json_stdin "$PDX_DATA_DIR/task-final-verify.json" $'Verify the smoke API and docs tasks together.\n' \
  "$PITHOS_BIN" task enqueue \
    --run run_toil-smoke \
    --scope "$REPO_SCOPE" \
    --capability triage \
    --title 'Smoke final verification' \
    --chain none \
    --depends-on "$EXEC_API_TASK" \
    --depends-on "$EXEC_DOCS_TASK" \
    --stdin
FINAL_VERIFY_TASK="$(json_value "$PDX_DATA_DIR/task-final-verify.json" '.task.id')"

run_json "$PITHOS_BIN" graph inspect --all --status queued --search smoke --json
run_json "$PITHOS_BIN" graph inspect --all --status queued --status done --search smoke --json
run_json "$PITHOS_BIN" graph inspect --all --search smoke --search execute --json
run_json "$PITHOS_BIN" graph inspect --all --since today --json
run_json "$PITHOS_BIN" graph inspect --all --search no-such-smoke-task --json
run_json "$PITHOS_BIN" graph inspect --scope "$REPO_SCOPE" --status queued --json
run_json "$PITHOS_BIN" graph inspect --scope "$REPO_SCOPE" --json
run_text "$PITHOS_BIN" graph inspect --scope "$REPO_SCOPE"
run_json "$PITHOS_BIN" graph inspect --task "$FINAL_VERIFY_TASK" --json
run_text "$PITHOS_BIN" graph inspect --task "$FINAL_VERIFY_TASK"

printf '\nSeeded smoke graph in %s\n' "$PITHOS_DB"
printf 'Key tasks: triage=%s design=%s escalation=%s handoff=%s api=%s docs=%s final=%s\n' \
  "$TRIAGE_TASK" \
  "$DESIGN_TASK" \
  "$ESCALATION_TASK" \
  "$HANDOFF_TASK" \
  "$EXEC_API_TASK" \
  "$EXEC_DOCS_TASK" \
  "$FINAL_VERIFY_TASK"
