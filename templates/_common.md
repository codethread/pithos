## Shared Pithos operating rules

- Pithos is durable truth for tasks, runs, claims, artifacts, events, and graph repair.
- Claim work with the rendered claim command before inspecting task body.
- A run may hold at most one task at a time.
- `PITHOS_RUN_ID`, `PITHOS_SCOPE_ID`, and `PITHOS_DB` are set in the environment.
- Claim succeeds with JSON like `{"ok":true,"task":{"id":"task_...","status":"claimed","token":1}}`; keep `task.id` and `task.token` for artifact, heartbeat, complete, and fail commands.
- If claim returns `NO_CLAIMABLE_WORK`, do not invent work or poll in a loop. AFK agents should exit cleanly; HITL agents should wait for the user or a control-plane wakeup.
- Use the fencing token returned by claim when completing or failing held work. If you lost it, inspect with `--json` and recover the current token before writing.
- Use your launch `scope_id` for normal same-scope follow-up work. Escalation tasks for Pandora must use global scope: `--scope global --capability escalate`.
- Scopes partition work queues. Use `pithos scope list` to discover existing scopes and `pithos scope upsert --kind repo|worktree --path <path>` to create or reactivate a scope before enqueueing work there.
- Global scope is for escalations or genuinely cross-project/unknown routing. Repo scope is good for project-level triage and design. Execution work should usually target a worktree scope so War can work in an isolated checkout.
- Creating a worktree scope records the path in Pithos; if the worktree directory does not exist yet, create it first with git/filesystem commands, then upsert the worktree scope and use the returned scope id for execute tasks.
- Pithos stores the full task graph; agents usually work the task chain reconstructed from it.
- A task chain is the inspectable history the user will review later: dependencies, source links, supersessions, artifacts, runs, and events together explain what happened.
- Dependencies gate claimability; source links are non-blocking provenance.
- Ordinary follow-up work should omit `--chain`: default auto keeps the held work chain connected.
- Add manual `--depends-on <task-id>` only for extra prerequisites/fan-in; it combines with default auto.
- Use `--chain none` for unrelated work, or `--chain none --depends-on <task-id>` for manual-only dependencies.
- Prefer concise downstream task bodies that reference upstream task/artifact ids; do not copy approved briefs or large context into every child task.
- Attach useful artifacts before completing substantial work so downstream agents and the user can inspect the chain. Artifact `--kind` is a short category; use conventions such as `triage`, `design-brief`, `war-completion`, `decision`, or `evidence`.
- For any Pithos command using `--stdin`, send exactly one stdin document; prefer quoted heredocs (`<<'EOF'`) and do not stage temp files solely for payload upload.
- Queue capabilities are `triage`, `design`, `execute`, and `escalate`; only enqueue capabilities listed in your launch context.
- Escalation is a normal global-scope task claimed by Pandora.
- pdx owns lifecycle cleanup, interrupt, timeout, and kill policy.

### Worktree and branch cleanup task ordering

Cleanup or removal tasks that can delete worktrees or local branches are destructive and irreversible. Never author them as flat (dependency-free) tasks when merge or land work targeting the same branches or worktrees may still be outstanding. Pithos only enforces ordering you encode — no dependency edge means immediately claimable.

War (execute) may only enqueue escalate tasks, so cleanup execute tasks must always be authored by Toil or Pandora — never by the agent running the merge itself.

**Best case — Toil authors merge and cleanup together.** When Toil creates the merge execute task, immediately enqueue the cleanup with an explicit `--depends-on` on the merge task. Both tasks are authored from the same held triage context:

```sh
# 1. Enqueue the merge task; note the returned task id (e.g. task_XYZ)
pithos task enqueue --run $PITHOS_RUN_ID --scope $PITHOS_SCOPE_ID --capability execute \
  --title 'Merge feat/my-feature' --stdin <<'EOF'
...
EOF

# 2. Enqueue cleanup with an explicit dependency on the merge task
#    Default auto chaining connects both to the triage source;
#    --depends-on task_XYZ is the blocking gate that prevents cleanup
#    from being claimed before the merge finishes.
pithos task enqueue --run $PITHOS_RUN_ID --scope $PITHOS_SCOPE_ID --capability execute \
  --title 'Remove worktree: feat/my-feature' --stdin \
  --depends-on task_XYZ <<'EOF'
Remove the worktree and local branch for feat/my-feature once task_XYZ (merge) has completed.
EOF
```

**If queued from an idle or manual context** (no held task — e.g. a Pandora-initiated sweep), enumerate every outstanding merge task whose worktree or branch the cleanup could remove and add explicit `--depends-on` for each:

```sh
# --chain none: no held task to auto-chain from
# --depends-on: blocks cleanup until each listed merge task completes
pithos task enqueue --run $PITHOS_RUN_ID --scope $PITHOS_SCOPE_ID --capability execute \
  --title 'Sweep merged worktrees' --stdin --chain none \
  --depends-on <merge-task-id-1> --depends-on <merge-task-id-2> <<'EOF'
Remove worktrees and local branches for PRs that have already merged.
Depends on <merge-task-id-1> and <merge-task-id-2> to ensure in-flight merges finish first.
EOF
```

For a **repo-wide sweep** (removes any merged worktree it finds), depend on _all_ outstanding merge tasks for the repo — not just the ones you expect to touch. A sweep can race work it was never explicitly linked to. If no merge tasks are currently in-flight for any candidate branch, you may omit `--depends-on`, but verify before skipping.

## Common command recipes

After claiming, inspect the held task:

```sh
pithos task inspect <task-id>
```

`task inspect` renders a Markdown handoff by default: current task, nearest upstream history, nested artifacts, direct dependencies, and compact unlocks. Use this readable view as your normal working context. Use `task inspect <task-id> --json` only when you need the full structured object for exact fields, scripting, or a lost fencing token.

Attach an artifact with a stdin body:

```sh
pithos task artifact add --run $PITHOS_RUN_ID --kind <kind> --title '<title>' --stdin <task-id> <<'EOF'
<artifact body>
EOF
```

Complete with default `{}` metadata:

```sh
pithos task complete --run $PITHOS_RUN_ID --token <token> <task-id>
```

Fail with a reason:

```sh
pithos task fail --run $PITHOS_RUN_ID --token <token> --reason '<reason>' <task-id>
```

Enqueue ordinary follow-up work with default auto chaining:

```sh
pithos task enqueue --run $PITHOS_RUN_ID --scope $PITHOS_SCOPE_ID --capability <triage|design|execute> --title '<title>' --stdin <<'EOF'
<task body>
EOF
```

Enqueue unrelated or manual-only work:

```sh
pithos task enqueue --run $PITHOS_RUN_ID --scope $PITHOS_SCOPE_ID --capability <triage|design|execute> --title '<title>' --stdin --chain none [--depends-on <task-id>] <<'EOF'
<task body>
EOF
```

Enqueue an escalation for Pandora while you still hold the current task:

```sh
pithos task enqueue --run $PITHOS_RUN_ID --scope global --capability escalate --title '<title>' --stdin <<'EOF'
<what the user/Pandora needs to know>
EOF
```
