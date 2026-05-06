---
name: smoke
description: run a manual smoke test of the full workflow with fresh db and cleanup
disable-model-invocation: true
---

# Workflow: fresh HITL Pandora delegation rerun

Use this runbook to repeat the real end-to-end delegation test in `~/dev/pithos`.

## Purpose

Run a real end-to-end orchestration smoke test for a small dependent implementation workflow:

`Pandora -> Toil -> Envy -> worker`

Target request:

> create a simple bash script in the pithos repo that first prints `hello`, then update it to print `hello pandora`

This workflow is successful only if Pandora does **not** implement the file herself, the delegated path is observable in Pithos state, and the dependency step is visible in the queueing/claim flow.

## References

Read these once; this workflow does not restate them.

- `AGENTS.md` — repo rules; fail loudly; strict IO; observability
- `README.md` — repo overview and operator entrypoints
- `packages/spawner/README.md` — `pandora-spawn` spawn/status/hook behavior
- `packages/spawner/claude-plugin/README.md` — Claude plugin / hook install path

## Variables

| Variable        | Value                                               | Notes                                                              |
| --------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| REPO_ROOT       | `~/dev/pithos`                                      | repo under test                                                    |
| DEFAULT_DB      | `~/.pandora/pithos.sqlite`                          | preferred DB on this machine unless explicitly testing propagation |
| SCOPE_KIND      | `repo`                                              | scope under test                                                   |
| REQUEST_TITLE   | `Write hello script then update to hello pandora via delegated path` | seed task title                                      |
| REQUEST_TARGET  | `scripts/hello.sh`                                                     | expected created file                                |
| VERIFY_CMD      | `test "$(bash scripts/hello.sh)" = "hello pandora"`                 | expected final verification command                  |
| TMP_DB_GLOB     | `/tmp/pithos-e2e.*`                                 | temp DB scratch path from prior runs                               |
| TEST_SESSION_RG | `pithos-(pandora\|toil\|envy)-`                   | tmux test session matcher                                          |

## Prerequisites

- `pnpm install` has already been run and local bins are buildable
- operator can run `pithos` and `pandora-spawn`
- repo worktree is clean before the rerun starts
- no leftover `scripts/hello.sh` from a prior attempt
- no reliance on terminal input injection

## Knowledge

### Machine-specific assumptions

- Prefer the **manual spawn flow** on this machine.
- Do **not** assume `scripts/pandora-start.sh` works here.
- Hooks install via the Claude Code plugin — see `packages/spawner/claude-plugin/README.md`.
- This workflow includes explicit cleanup both **before** and **after** a rerun so the next rerun starts from known state.
- Always capture the report first, then tear down DB/files/sessions.

### DB mode

- Preferred mode for repeat runs on this machine: use the freshly dropped `DEFAULT_DB` intentionally.
- Only use a temp DB if you are explicitly testing `PITHOS_DB` propagation into spawned Claude sessions.
- If you use a temp DB, you must verify spawned sessions are using the same DB before trusting results.

### Observation mode

- Prefer `pandora-spawn status --session-id <id>` for session observation.
- Prefer `pithos inspect graph --current` for the authoritative one-shot view of current work across scopes.
- Use `pandora-spawn tty-status` only for harness debugging when `status` is missing, stale, or clearly misleading.
- Keep all state mutations flowing through `pithos`.

### Workflow observations to capture

During the run, record the actual values and transitions you observe rather than inferring intent:

- which queue capabilities Toil and Envy actually used
- whether Toil created a real dependency edge between the two implementation steps
- whether the second implementation step stayed blocked until the first was complete
- whether worker-backed execution was visible for the repo mutations

If any of those observations diverge from the intended workflow, report the exact commands and outputs that showed it.

## Decisions

Entry state: `PRECHECK`

### PRECHECK

- guard: repo dirty, leftover hello script, or stale test session exists
  -> `RESET_STATE`
- guard: clean enough to proceed
  -> `VERIFY_BASELINE`

### RESET_STATE

- action: remove only known test leftovers; do not mutate unrelated repo state
- always -> `VERIFY_BASELINE`

### VERIFY_BASELINE

- action: run baseline checks
- guard: all checks pass
  -> `INIT_STATE`
- guard: any check fails
  -> `STOP_FAILURE`

### INIT_STATE

- action: initialize fresh Pithos state and upsert repo scope
- always -> `SEED_REQUEST`

### SEED_REQUEST

- action: enqueue the hello-script request into Pithos before spawning Pandora
- note: do this because terminal input injection is forbidden
- always -> `SPAWN_PANDORA`

### SPAWN_PANDORA

- action: spawn Pandora in the repo scope
- guard: spawn succeeds
  -> `OBSERVE_DELEGATION`
- guard: spawn fails
  -> `STOP_FAILURE`

### OBSERVE_DELEGATION

- action: poll with `pandora-spawn status`, `pithos tail`, `pithos briefing`, `pithos inspect`
- guard: Pandora delegates to Toil, Toil emits actionable chained work, Envy claims implementation work in dependency order, separate worker sub-session(s) execute the mutations, artifacts appear, and the chain completes
  -> `VALIDATE_SUCCESS`
- guard: Pandora edits directly
  -> `STOP_FAILURE`
- guard: delegation stalls or capability/routing mismatch appears
  -> `STOP_FAILURE`
- guard: human input is required to continue
  -> `STOP_REPORT`

### VALIDATE_SUCCESS

- action: verify file, verification command, tasks, runs, artifacts, hooks, DB assumptions
- guard: all success criteria satisfied
  -> `REPORT_AND_CLEANUP`
- guard: any success criterion missing
  -> `STOP_FAILURE`

### REPORT_AND_CLEANUP

- action: capture the final report, then tear down test state for the next rerun
- always -> `DONE`

### STOP_REPORT

- terminal state: stop and report what additional human input would be required

### STOP_FAILURE

- terminal state: report the exact failing step, command, and observed output, then clean up when evidence is no longer needed

### DONE

- terminal state: report captured and test state cleaned for the next rerun

## Procedures

### 1. Pre-run cleanup

From `REPO_ROOT`, remove only the known rerun leftovers:

```sh
rm -f scripts/hello.sh
rm -f ~/.pandora/pithos.sqlite
rm -rf /tmp/pithos-e2e.*
tmux ls 2>/dev/null | rg 'pithos-(pandora|toil|envy)-' || true
```

If test sessions are present, kill them before continuing:

```sh
tmux ls 2>/dev/null | rg 'pithos-(pandora|toil|envy)-' | cut -d: -f1 | xargs -r -n1 tmux kill-session -t
```

Then confirm cleanup:

```sh
test ! -e scripts/hello.sh
test ! -e ~/.pandora/pithos.sqlite
```

### 2. Baseline

From `REPO_ROOT`:

```sh
git status --short
pnpm lint
pnpm typecheck
pnpm test
pnpm run build
```

### 3. Initialize fresh Pithos state

```sh
cd ~/dev/pithos
pithos init
scope_json="$(pithos scope upsert --kind repo --path "$PWD")"
scope_id="$(printf '%s' "$scope_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).scope.id))')"
printf '%s\n' "$scope_id"
```

Expected scope for this repo:

```text
repo:dev/pithos
```

### 4. Seed the request into Pithos

Create the request body and enqueue it as a triage task:

```sh
cat >/tmp/pithos-hello-task.md <<'EOF'
Target request: implement a tiny two-step dependent workflow in the pithos repo.

Desired end state:
1. create `scripts/hello.sh` so it prints `hello`
2. then update the same script so it prints `hello pandora`

Hard requirements:
- Pandora must not write the file herself.
- The repo mutations must route through Toil -> Envy -> a separate worker sub-session.
- Toil should express the work as at least two actionable tasks with a real dependency edge between them.
- The second implementation step must remain blocked until the first is complete.
- Envy must remain coordinator/reporter; worker sub-session(s) must perform the repo mutation.
- Envy should attach `worker-completion` artifacts before completion.
- Final verification command: test "$(bash scripts/hello.sh)" = "hello pandora"
- Report concrete run/task/artifact ids and the observed dependency evidence.
EOF

pithos enqueue \
  --scope "$scope_id" \
  --capability triage \
  --title 'Write hello script then update to hello pandora via delegated path' \
  --body-file /tmp/pithos-hello-task.md
```

Capture the returned seed task id.

### 5. Spawn Pandora

```sh
pandora-spawn --agent pandora --scope "$scope_id" --cwd "$PWD"
```

Capture at least:

- `run_id`
- `session_id`
- `tmux_session`

### 6. Observe, do not inject

Preferred observation commands:

```sh
pandora-spawn status --session-id <session_id> --lines 50
pithos briefing --agent pandora
pithos inspect graph --current
pithos tail --limit 100
pithos inspect run <run_id>
pithos inspect task <task_id>
```

Typical progression to look for:

1. Pandora inspects briefing / graph / task state
2. Pandora spawns Toil
3. Toil claims the triage task
4. Toil creates at least two actionable child tasks for Envy with a dependency between them
5. Pandora spawns Envy for the first implementation step
6. Envy claims the first actionable task
7. Envy delegates the mutating work to a separate worker sub-session
8. worker creates `scripts/hello.sh` so it prints `hello`
9. Envy verifies it, adds `worker-completion` artifact, completes the first task
10. the second implementation step becomes ready only after the first is complete
11. Pandora spawns Envy for the second step (or otherwise ensures it is claimed through the normal path)
12. worker updates `scripts/hello.sh` so it prints `hello pandora`
13. Envy verifies it, adds `worker-completion` artifact, completes the second task
14. Pandora reports the result from Pithos state

### 7. Validate success

File and command:

```sh
test -f scripts/hello.sh
test "$(bash scripts/hello.sh)" = "hello pandora"
```

Pithos state:

```sh
pithos inspect task <final_task_id>
pithos inspect run <pandora_run_id>
pithos inspect run <toil_run_id>
pithos inspect run <envy_run_id>
pithos inspect graph --current
pithos briefing --agent pandora
```

Hook evidence:

- inspect run records for `last_hook`
- note whether `PreToolUse` and/or `SessionEnd` were observed

DB evidence:

- if using `DEFAULT_DB`, say so explicitly
- if using a temp DB, prove spawned runs used that DB before claiming success

### 8. Post-run cleanup

After the final report is captured, tear down the rerun state so the next execution starts clean:

```sh
rm -f scripts/hello.sh
rm -f ~/.pandora/pithos.sqlite
rm -rf /tmp/pithos-e2e.*
tmux ls 2>/dev/null | rg 'pithos-(pandora|toil|envy)-' | cut -d: -f1 | xargs -r -n1 tmux kill-session -t
```

Then confirm cleanup:

```sh
test ! -e scripts/hello.sh
test ! -e ~/.pandora/pithos.sqlite
tmux ls 2>/dev/null | rg 'pithos-(pandora|toil|envy)-' && false || true
```

## Constraints

- Never use `tmux send-keys`.
- Never use `pandora-spawn nudge`.
- Never inject terminal input into spawned sessions.
- Never let Pandora satisfy the request by editing the file itself.
- Never let Envy satisfy a mutating `implement` task by editing the file itself.
- Never mutate Pithos state except through `pithos`.
- Never call the rerun successful if the worker path is unobserved.
- Never silently reinterpret a failure as success.
- Never skip teardown once reporting is complete.

## Validation

Report success only if all of the following are true:

- [ ] fresh DB at start
- [ ] baseline checks passed before the rerun
- [ ] Pandora spawned successfully
- [ ] Pandora did not write the file herself
- [ ] Toil delegation was observable
- [ ] Envy delegation was observable
- [ ] worker-style execution was observable
- [ ] Toil created at least two actionable implementation tasks with a real dependency edge
- [ ] the second implementation task remained blocked until the first was complete
- [ ] `scripts/hello.sh` exists
- [ ] `test "$(bash scripts/hello.sh)" = "hello pandora"` succeeded
- [ ] `worker-completion` artifact(s) exist for the completed implementation task(s)
- [ ] final report includes concrete IDs, commands, and dependency evidence
- [ ] rerun leftovers were cleaned after reporting (`hello.sh`, DB, temp DB dirs, test tmux sessions)

## Report template

Always capture these exact facts:

- Pandora run id
- Pandora session id
- Toil run id (if used)
- Envy run id(s)
- worker session id(s) (if any)
- seed triage task id
- implementation task ids in dependency order
- artifact id(s)
- file path created
- verification command run
- the command/output that proved the dependency edge and blocked->ready transition
- whether hooks were active
- whether `PITHOS_DB` propagation was correct
- exact failing step and output if the rerun failed
