# Pithos backbone demo

Replayable CLI-only walkthrough for slice 3.

## Prereqs

- `pnpm install`
- `jq`
- run from repo root

## Demo

```bash
set -euo pipefail

ROOT=$(pwd)
DEMO_DIR=$(mktemp -d)
DB_PATH="$DEMO_DIR/pithos-next.sqlite"
REPO_A="$DEMO_DIR/repo-a"
REPO_B="$DEMO_DIR/repo-b"
mkdir -p "$REPO_A" "$REPO_B"

export PITHOS_DB="$DB_PATH"
export PITHOS_LOG_LEVEL=none

pnpm --filter @pithos/pithos build >/dev/null
PITHOS_BIN="$ROOT/packages/pithos/bin/pithos-next"

pithos() {
  "$PITHOS_BIN" "$@"
}

json() {
  "$@" | tee /dev/stderr | jq -r .
}

echo "== init + scope upserts =="
json pithos init --fresh >/dev/null
json pithos scope upsert --kind global >/dev/null
GLOBAL_SCOPE=global
REPO_A_SCOPE=$(pithos scope upsert --kind repo --path "$REPO_A" | jq -r '.scope.id')
REPO_B_SCOPE=$(pithos scope upsert --kind repo --path "$REPO_B" | jq -r '.scope.id')

echo "== run upserts for all built-in agents =="
PANDORA_RUN=$(pithos run upsert --agent pandora --mode hitl --scope "$GLOBAL_SCOPE" --cwd "$DEMO_DIR" --session-id session_pandora --run run_pandora | jq -r '.run.id')
TOIL_RUN=$(pithos run upsert --agent toil --mode afk --scope "$GLOBAL_SCOPE" --cwd "$DEMO_DIR" --session-id session_toil --run run_toil | jq -r '.run.id')
GREED_RUN=$(pithos run upsert --agent greed --mode hitl --scope "$GLOBAL_SCOPE" --cwd "$DEMO_DIR" --session-id session_greed --run run_greed | jq -r '.run.id')
WAR_RUN=$(pithos run upsert --agent war --mode afk --scope "$REPO_A_SCOPE" --cwd "$REPO_A" --session-id session_war --run run_war | jq -r '.run.id')
PDX_RUN=$(pithos run upsert --agent pdx --mode afk --scope "$GLOBAL_SCOPE" --cwd "$DEMO_DIR" --session-id session_pdx --run run_pdx | jq -r '.run.id')

echo "== enqueue triage / design / execute / escalate =="
TRIAGE_TASK=$(pithos task enqueue --run "$PANDORA_RUN" --scope "$GLOBAL_SCOPE" --capability triage --title "Break goal down" --body "Produce actionable plan" | jq -r '.task.id')
DESIGN_TASK=$(pithos task enqueue --run "$TOIL_RUN" --scope "$GLOBAL_SCOPE" --capability design --title "Review design constraints" --body "Check sharp edges" --depends-on "$TRIAGE_TASK" | jq -r '.task.id')
EXECUTE_TASK=$(pithos task enqueue --run "$TOIL_RUN" --scope "$REPO_A_SCOPE" --capability execute --title "Implement backend change" --body "Modify repo A" --depends-on "$DESIGN_TASK" | jq -r '.task.id')
ESCALATE_TASK=$(pithos task enqueue --run "$PANDORA_RUN" --scope "$GLOBAL_SCOPE" --capability escalate --title "Review implementation plan" --body "Pandora checkpoint" --depends-on "$DESIGN_TASK" | jq -r '.task.id')

echo "== graph / inspect / briefing after enqueue =="
pithos graph inspect --all | tee /dev/stderr | jq -r '.graph.nodes | length'
pithos task inspect "$EXECUTE_TASK" | tee /dev/stderr | jq -r '.task.id'
pithos briefing --agent pandora | tee /dev/stderr >/dev/null

echo "== happy path: claim -> heartbeat -> complete triage =="
TRIAGE_CLAIM=$(pithos task claim --run "$TOIL_RUN" --scope "$GLOBAL_SCOPE" --capability triage)
TRIAGE_TOKEN=$(echo "$TRIAGE_CLAIM" | jq -r '.task.fencing_token')
pithos task heartbeat --run "$TOIL_RUN" --task "$TRIAGE_TASK" --token "$TRIAGE_TOKEN" | tee /dev/stderr >/dev/null
printf '{"summary":"triage done"}\n' > "$DEMO_DIR/triage-result.json"
pithos task complete "$TRIAGE_TASK" --run "$TOIL_RUN" --token "$TRIAGE_TOKEN" --result-file "$DEMO_DIR/triage-result.json" | tee /dev/stderr >/dev/null

echo "== unhappy path: claim -> heartbeat -> fail design =="
DESIGN_CLAIM=$(pithos task claim --run "$GREED_RUN" --scope "$GLOBAL_SCOPE" --capability design)
DESIGN_TOKEN=$(echo "$DESIGN_CLAIM" | jq -r '.task.fencing_token')
pithos task heartbeat --run "$GREED_RUN" --task "$DESIGN_TASK" --token "$DESIGN_TOKEN" | tee /dev/stderr >/dev/null
pithos task fail "$DESIGN_TASK" --run "$GREED_RUN" --token "$DESIGN_TOKEN" --reason "design needs revision" | tee /dev/stderr >/dev/null

echo "== run lifecycle commands =="
IDLE_RUN=$(pithos run upsert --agent greed --mode hitl --scope "$GLOBAL_SCOPE" --cwd "$DEMO_DIR" --session-id session_idle --run run_idle | jq -r '.run.id')
pithos run cleanup --run "$IDLE_RUN" --reason "demo idle cleanup" | tee /dev/stderr >/dev/null

INTERRUPT_RUN=$(pithos run upsert --agent toil --mode afk --scope "$GLOBAL_SCOPE" --cwd "$DEMO_DIR" --session-id session_interrupt --run run_interrupt | jq -r '.run.id')
INTERRUPT_TASK=$(pithos task enqueue --run "$PANDORA_RUN" --scope "$GLOBAL_SCOPE" --capability triage --title "Interrupt me" --body "demo" | jq -r '.task.id')
INTERRUPT_CLAIM=$(pithos task claim --run "$INTERRUPT_RUN" --scope "$GLOBAL_SCOPE" --capability triage)
INTERRUPT_TOKEN=$(echo "$INTERRUPT_CLAIM" | jq -r '.task.fencing_token')
pithos run interrupt --run "$INTERRUPT_RUN" --reason "demo operator kill" | tee /dev/stderr >/dev/null

TIMEOUT_RUN=$(pithos run upsert --agent war --mode afk --scope "$REPO_A_SCOPE" --cwd "$REPO_A" --session-id session_timeout --run run_timeout | jq -r '.run.id')
pithos run timeout --run "$TIMEOUT_RUN" --reason "demo no-claim timeout" | tee /dev/stderr >/dev/null

echo "== supersede failed design; queued direct dependents retarget =="
DESIGN_REPLACEMENT=$(pithos task supersede "$DESIGN_TASK" --run "$TOIL_RUN" --reason "retry design with better framing" | tee /dev/stderr | jq -r '.task.id')
pithos task inspect "$ESCALATE_TASK" | tee /dev/stderr | jq -r '.task.unresolved_dependency_ids[0]'
pithos task inspect "$EXECUTE_TASK" | tee /dev/stderr | jq -r '.task.unresolved_dependency_ids[0]'

echo "== cross-scope supersede rejection when queued dependents exist =="
set +e
CROSS_SCOPE_OUTPUT=$(pithos task supersede "$DESIGN_REPLACEMENT" --run "$TOIL_RUN" --reason "illegal move" --scope "$REPO_B_SCOPE" 2>&1)
CROSS_SCOPE_EXIT=$?
set -e
printf '%s\n' "$CROSS_SCOPE_OUTPUT"
[ "$CROSS_SCOPE_EXIT" -ne 0 ]
printf '%s\n' "$CROSS_SCOPE_OUTPUT" | rg 'queued direct dependents would be retargeted across scopes'

echo "== cancel queued task =="
CANCELLED_TASK=$(pithos task enqueue --run "$PANDORA_RUN" --scope "$GLOBAL_SCOPE" --capability triage --title "Cancel me" --body "demo" | jq -r '.task.id')
pithos task cancel "$CANCELLED_TASK" --run "$PANDORA_RUN" --reason "no longer needed" | tee /dev/stderr >/dev/null

echo "== events / graph / task inspect / briefing at end =="
pithos events tail --limit 50 | tee /dev/stderr | jq -r '.count'
pithos graph inspect --all | tee /dev/stderr | jq -r '.graph.edges | length'
pithos task inspect "$DESIGN_TASK" | tee /dev/stderr | jq -r '.superseded_by.id'
pithos briefing --agent pandora | tee /dev/stderr >/dev/null

echo "demo db: $DB_PATH"
```