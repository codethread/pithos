#!/usr/bin/env bash
set -euo pipefail

PITHOS_BIN=${PITHOS_BIN:-pithos}
WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/pithos-backbone.XXXXXX")
export PITHOS_DB="$WORKDIR/pithos.db"

run_json() {
  "$PITHOS_BIN" "$@" | tee "$WORKDIR/last.json"
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

run_json run upsert --agent pdx --mode afk --scope "$global_scope" --cwd "$WORKDIR" --session-id s_pdx --run run_pdx
run_json run upsert --agent pandora --mode hitl --scope "$global_scope" --cwd "$WORKDIR" --session-id s_pandora --run run_pandora
run_json run upsert --agent toil --mode afk --scope "$global_scope" --cwd "$WORKDIR" --session-id s_toil --run run_toil
run_json run upsert --agent greed --mode hitl --scope "$global_scope" --cwd "$WORKDIR" --session-id s_greed --run run_greed
run_json run upsert --agent war --mode afk --scope "$repo_scope" --cwd "$WORKDIR/repo" --session-id s_war --run run_war
run_json run upsert --agent war --mode afk --scope "$worktree_scope" --cwd "$WORKDIR/worktree" --session-id s_war_worktree --run run_war_worktree

run_json task enqueue --scope "$global_scope" --capability triage --title triage --body 'route work' --run run_pandora
triage_task=$(id '.task.id')
run_json task enqueue --scope "$global_scope" --capability design --title design --body 'design work' --run run_toil
design_task=$(id '.task.id')
run_json task enqueue --scope "$repo_scope" --capability execute --title execute --body 'mutate repo' --run run_toil --depends-on "$design_task"
execute_task=$(id '.task.id')
run_json task enqueue --scope "$global_scope" --capability escalate --title checkpoint --body 'review' --run run_pdx --depends-on "$execute_task"
escalate_task=$(id '.task.id')

expect_fail VALIDATION_ERROR 'execute requires repo/worktree scope' \
  task claim --scope "$global_scope" --capability execute --run run_toil
expect_fail VALIDATION_ERROR 'war is not authorized for triage' \
  task claim --scope "$repo_scope" --capability triage --run run_war
expect_fail VALIDATION_ERROR 'war is not authorized for execute' \
  task enqueue --scope "$repo_scope" --capability execute --title bad --body bad --run run_war
expect_fail VALIDATION_ERROR 'escalate requires global scope' \
  task enqueue --scope "$repo_scope" --capability escalate --title bad --body bad --run run_pdx
expect_fail VALIDATION_ERROR 'execute requires repo/worktree scope' \
  task enqueue --scope "$global_scope" --capability execute --title bad --body bad --run run_toil

run_json briefing --agent war
jq -e --arg t "$execute_task" '.blocked[] | select(.id == $t)' "$WORKDIR/last.json" >/dev/null
run_json task claim --scope "$global_scope" --capability design --run run_greed
claimed_design=$(id '.task.id')
[[ "$claimed_design" == "$design_task" ]]
run_json task heartbeat --run run_greed --task "$design_task" --token 1
run_json task complete "$design_task" --run run_greed --token 1
run_json briefing --agent war
jq -e --arg t "$execute_task" '.ready[] | select(.id == $t)' "$WORKDIR/last.json" >/dev/null
run_json task claim --scope "$repo_scope" --capability execute --run run_war
run_json task heartbeat --run run_war --task "$execute_task" --token 1
run_json task fail "$execute_task" --run run_war --token 1 --reason 'demo failure'

run_json task enqueue --scope "$repo_scope" --capability execute --title downstream --body 'after repair' --run run_toil --depends-on "$execute_task"
downstream_task=$(id '.task.id')
run_json task supersede "$execute_task" --run run_toil --reason repair --title 'execute repaired' --body 'fixed execution'
replacement_task=$(id '.task.id')
run_json task inspect "$downstream_task"
jq -e --arg t "$replacement_task" '.dependencies[] | select(.id == $t)' "$WORKDIR/last.json" >/dev/null

run_json task enqueue --scope "$repo_scope" --capability execute --title cross-old --body old --run run_toil
cross_old=$(id '.task.id')
run_json task enqueue --scope "$repo_scope" --capability execute --title cross-child --body child --run run_toil --depends-on "$cross_old"
expect_fail VALIDATION_ERROR 'cannot change scope while retargeting queued dependents' \
  task supersede "$cross_old" --run run_toil --reason 'move scope' --scope "$worktree_scope" --body moved

run_json task enqueue --scope "$global_scope" --capability triage --title cancel-me --body 'no longer needed' --run run_toil
cancel_task=$(id '.task.id')
run_json task cancel "$cancel_task" --run run_toil --reason 'demo cancel'

run_json task enqueue --scope "$worktree_scope" --capability execute --title cleanup --body cleanup --run run_toil
cleanup_task=$(id '.task.id')
run_json run upsert --agent war --mode afk --scope "$worktree_scope" --cwd "$WORKDIR/worktree" --session-id s_cleanup --run run_cleanup
run_json task claim --scope "$worktree_scope" --capability execute --run run_cleanup
[[ "$(id '.task.id')" == "$cleanup_task" ]]
run_json run cleanup --run run_cleanup --reason 'natural death'
run_json run inspect run_cleanup
jq -e '.run.status == "failed" and .run.task_id == null' "$WORKDIR/last.json" >/dev/null
run_json task inspect "$cleanup_task"
jq -e '.task.status == "queued"' "$WORKDIR/last.json" >/dev/null

run_json task enqueue --scope "$interrupt_scope" --capability execute --title interrupt --body interrupt --run run_toil
interrupt_task=$(id '.task.id')
run_json run upsert --agent war --mode afk --scope "$interrupt_scope" --cwd "$WORKDIR/worktree-interrupt" --session-id s_interrupt --run run_interrupt
run_json task claim --scope "$interrupt_scope" --capability execute --run run_interrupt
[[ "$(id '.task.id')" == "$interrupt_task" ]]
run_json run interrupt --task "$interrupt_task" --reason 'operator stop'
run_json run inspect run_interrupt
jq -e '.run.status == "failed" and .run.task_id == null' "$WORKDIR/last.json" >/dev/null
run_json task inspect "$interrupt_task"
jq -e '.task.status == "failed"' "$WORKDIR/last.json" >/dev/null

run_json run upsert --agent war --mode afk --scope "$worktree_scope" --cwd "$WORKDIR/worktree" --session-id s_timeout --run run_timeout
run_json run timeout --run run_timeout --reason 'no claim bootstrap timeout'
run_json run inspect run_timeout
jq -e '.run.status == "timed_out" and .run.task_id == null' "$WORKDIR/last.json" >/dev/null

run_json graph inspect --all
jq -e --arg old "$execute_task" --arg new "$replacement_task" \
  '.graph.edges[] | select(.kind == "supersedes" and .from_task_id == $new and .to_task_id == $old)' \
  "$WORKDIR/last.json" >/dev/null
run_json graph inspect --task "$downstream_task" --flat --dump
run_json task inspect "$replacement_task"
jq -e --arg dep "$design_task" '.dependencies[] | select(.id == $dep and .status == "done")' "$WORKDIR/last.json" >/dev/null
run_json events tail --limit 50
jq -e '[.events[].type] | contains(["task.reclaimed", "task.interrupted", "run.timed_out", "task.cancelled", "task.superseded"])' "$WORKDIR/last.json" >/dev/null
run_json briefing
jq -e --arg t "$replacement_task" '.ready[] | select(.id == $t)' "$WORKDIR/last.json" >/dev/null

echo "Pithos backbone demo complete. DB: $PITHOS_DB"
