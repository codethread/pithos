#!/usr/bin/env bash
set -euo pipefail

PITHOS_BIN=${PITHOS_BIN:-pithos}
WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/pithos-backbone.XXXXXX")
export PITHOS_DB="$WORKDIR/pithos.db"

run_json() {
  "$PITHOS_BIN" "$@" | tee "$WORKDIR/last.json"
}

run_stdin_json() {
  local payload=$1
  shift
  printf '%s' "$payload" | "$PITHOS_BIN" "$@" | tee "$WORKDIR/last.json"
}

expect_fail_stdin() {
  local code=$1
  local message_fragment=$2
  local payload=$3
  shift 3
  set +e
  printf '%s' "$payload" | "$PITHOS_BIN" "$@" >"$WORKDIR/fail.out" 2>"$WORKDIR/fail.err"
  local status=$?
  set -e
  if [[ $status -eq 0 ]]; then
    echo "expected failure: $*" >&2
    exit 1
  fi
  jq -e --arg code "$code" --arg fragment "$message_fragment" \
    '.ok == false and .error.code == $code and (.error.message | contains($fragment))' \
    "$WORKDIR/fail.err" >/dev/null
  cat "$WORKDIR/fail.err"
}

expect_fail() {
  local code=$1
  local message_fragment=$2
  shift 2
  set +e
  "$PITHOS_BIN" "$@" >"$WORKDIR/fail.out" 2>"$WORKDIR/fail.err"
  local status=$?
  set -e
  if [[ $status -eq 0 ]]; then
    echo "expected failure: $*" >&2
    exit 1
  fi
  jq -e --arg code "$code" --arg fragment "$message_fragment" \
    '.ok == false and .error.code == $code and (.error.message | contains($fragment))' \
    "$WORKDIR/fail.err" >/dev/null
  cat "$WORKDIR/fail.err"
}

id() { jq -r "$1" "$WORKDIR/last.json"; }

run_json init --fresh
run_json scope upsert --kind global
global_scope=$(id '.scope.id')
run_json scope upsert --kind repo --path "$WORKDIR/repo"
repo_scope=$(id '.scope.id')
run_json scope upsert --kind worktree --path "$WORKDIR/worktree"
worktree_scope=$(id '.scope.id')
run_json scope upsert --kind worktree --path "$WORKDIR/worktree-interrupt"
interrupt_scope=$(id '.scope.id')

run_json run upsert --agent pdx --mode afk --scope "$global_scope" --cwd "$WORKDIR" --session-id s_pdx --harness-kind system --session-log-path "$WORKDIR/s_pdx.jsonl" --run run_pdx
run_json run upsert --agent pandora --mode hitl --scope "$global_scope" --cwd "$WORKDIR" --session-id s_pandora --harness-kind pi --session-log-path "$WORKDIR/s_pandora.jsonl" --run run_pandora
run_json run upsert --agent toil --mode afk --scope "$global_scope" --cwd "$WORKDIR" --session-id s_toil --harness-kind pi --session-log-path "$WORKDIR/s_toil.jsonl" --run run_toil
run_json run upsert --agent greed --mode hitl --scope "$global_scope" --cwd "$WORKDIR" --session-id s_greed --harness-kind pi --session-log-path "$WORKDIR/s_greed.jsonl" --run run_greed
run_json run upsert --agent war --mode afk --scope "$repo_scope" --cwd "$WORKDIR/repo" --session-id s_war --harness-kind pi --session-log-path "$WORKDIR/s_war.jsonl" --run run_war
run_json run upsert --agent war --mode afk --scope "$worktree_scope" --cwd "$WORKDIR/worktree" --session-id s_war_worktree --harness-kind pi --session-log-path "$WORKDIR/s_war_worktree.jsonl" --run run_war_worktree

run_stdin_json 'route work' task enqueue --scope "$global_scope" --capability triage --title triage --stdin --run run_pandora
triage_task=$(id '.task.id')
run_stdin_json 'design work' task enqueue --scope "$global_scope" --capability design --title design --stdin --run run_toil
design_task=$(id '.task.id')
run_stdin_json 'mutate repo' task enqueue --scope "$repo_scope" --capability execute --title execute --stdin --run run_toil --depends-on "$design_task"
execute_task=$(id '.task.id')
run_stdin_json 'review' task enqueue --scope "$global_scope" --capability escalate --title checkpoint --stdin --run run_pdx --depends-on "$execute_task"
escalate_task=$(id '.task.id')

expect_fail VALIDATION_ERROR 'execute requires repo/worktree scope' \
  task claim --scope "$global_scope" --capability execute --run run_toil
expect_fail VALIDATION_ERROR 'war is not authorized for triage' \
  task claim --scope "$repo_scope" --capability triage --run run_war
expect_fail_stdin VALIDATION_ERROR 'war is not authorized for execute' bad \
  task enqueue --scope "$repo_scope" --capability execute --title bad --stdin --run run_war
expect_fail_stdin VALIDATION_ERROR 'escalate requires global scope' bad \
  task enqueue --scope "$repo_scope" --capability escalate --title bad --stdin --run run_pdx
expect_fail_stdin VALIDATION_ERROR 'execute requires repo/worktree scope' bad \
  task enqueue --scope "$global_scope" --capability execute --title bad --stdin --run run_toil

run_json briefing --agent war --json
jq -e --arg t "$execute_task" '.blocked[] | select(.id == $t)' "$WORKDIR/last.json" >/dev/null
run_json task claim --scope "$global_scope" --capability design --run run_greed
claimed_design=$(id '.task.id')
[[ "$claimed_design" == "$design_task" ]]
run_json task heartbeat --run run_greed --task "$design_task" --token 1
run_json task complete "$design_task" --run run_greed --token 1
run_json briefing --agent war --json
jq -e --arg t "$execute_task" '.ready[] | select(.id == $t)' "$WORKDIR/last.json" >/dev/null
run_json task claim --scope "$repo_scope" --capability execute --run run_war
run_json task heartbeat --run run_war --task "$execute_task" --token 1
run_json task fail "$execute_task" --run run_war --token 1 --reason 'demo failure'

run_stdin_json 'after repair' task enqueue --scope "$repo_scope" --capability execute --title downstream --stdin --run run_toil --depends-on "$execute_task"
downstream_task=$(id '.task.id')
run_stdin_json 'fixed execution' task supersede "$execute_task" --run run_toil --reason repair --title 'execute repaired' --stdin
replacement_task=$(id '.task.id')
run_json task inspect "$downstream_task" --json
jq -e --arg t "$replacement_task" '.dependencies[] | select(.id == $t)' "$WORKDIR/last.json" >/dev/null

run_stdin_json old task enqueue --scope "$repo_scope" --capability execute --title cross-old --stdin --run run_toil
cross_old=$(id '.task.id')
run_stdin_json child task enqueue --scope "$repo_scope" --capability execute --title cross-child --stdin --run run_toil --depends-on "$cross_old"
expect_fail_stdin VALIDATION_ERROR 'cannot change scope while retargeting queued dependents' moved \
  task supersede "$cross_old" --run run_toil --reason 'move scope' --scope "$worktree_scope" --stdin

run_stdin_json 'no longer needed' task enqueue --scope "$global_scope" --capability triage --title cancel-me --stdin --run run_toil
cancel_task=$(id '.task.id')
run_json task cancel "$cancel_task" --run run_toil --reason 'demo cancel'

run_stdin_json cleanup task enqueue --scope "$worktree_scope" --capability execute --title cleanup --stdin --run run_toil
cleanup_task=$(id '.task.id')
run_json run upsert --agent war --mode afk --scope "$worktree_scope" --cwd "$WORKDIR/worktree" --session-id s_cleanup --harness-kind pi --session-log-path "$WORKDIR/s_cleanup.jsonl" --run run_cleanup
run_json task claim --scope "$worktree_scope" --capability execute --run run_cleanup
[[ "$(id '.task.id')" == "$cleanup_task" ]]
run_json run cleanup --run run_cleanup --reason 'natural death'
run_json run inspect run_cleanup
jq -e '.run.status == "failed" and .run.task_id == null' "$WORKDIR/last.json" >/dev/null
run_json task inspect "$cleanup_task" --json
jq -e '.task.status == "queued"' "$WORKDIR/last.json" >/dev/null

run_stdin_json interrupt task enqueue --scope "$interrupt_scope" --capability execute --title interrupt --stdin --run run_toil
interrupt_task=$(id '.task.id')
run_json run upsert --agent war --mode afk --scope "$interrupt_scope" --cwd "$WORKDIR/worktree-interrupt" --session-id s_interrupt --harness-kind pi --session-log-path "$WORKDIR/s_interrupt.jsonl" --run run_interrupt
run_json task claim --scope "$interrupt_scope" --capability execute --run run_interrupt
[[ "$(id '.task.id')" == "$interrupt_task" ]]
run_json run interrupt --task "$interrupt_task" --reason 'operator stop'
run_json run inspect run_interrupt
jq -e '.run.status == "failed" and .run.task_id == null' "$WORKDIR/last.json" >/dev/null
run_json task inspect "$interrupt_task" --json
jq -e '.task.status == "failed"' "$WORKDIR/last.json" >/dev/null

run_json run upsert --agent war --mode afk --scope "$worktree_scope" --cwd "$WORKDIR/worktree" --session-id s_timeout --harness-kind pi --session-log-path "$WORKDIR/s_timeout.jsonl" --run run_timeout
run_json run timeout --run run_timeout --reason 'no claim bootstrap timeout'
run_json run inspect run_timeout
jq -e '.run.status == "timed_out" and .run.task_id == null' "$WORKDIR/last.json" >/dev/null

run_json graph inspect --all --json
jq -e --arg old "$execute_task" --arg new "$replacement_task" \
  '.graph.edges[] | select(.kind == "supersedes" and .from_task_id == $new and .to_task_id == $old)' \
  "$WORKDIR/last.json" >/dev/null
"$PITHOS_BIN" graph inspect --task "$downstream_task"
run_json task inspect "$replacement_task" --json
jq -e --arg dep "$design_task" '.dependencies[] | select(.id == $dep and .status == "done")' "$WORKDIR/last.json" >/dev/null
run_json events tail --limit 50
jq -e '[.events[].type] | contains(["task.reclaimed", "task.interrupted", "run.timed_out", "task.cancelled", "task.superseded"])' "$WORKDIR/last.json" >/dev/null
run_json briefing --json
jq -e --arg t "$replacement_task" '.ready[] | select(.id == $t)' "$WORKDIR/last.json" >/dev/null

echo "Pithos backbone demo complete. DB: $PITHOS_DB"
