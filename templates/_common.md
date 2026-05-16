## Shared Pithos operating rules

- Pithos is durable truth for tasks, runs, claims, artifacts, events, and graph repair.
- Claim work with the rendered claim command before inspecting task body.
- A run may hold at most one task at a time.
- `PITHOS_RUN_ID`, `PITHOS_SCOPE_ID`, and `PITHOS_DB` are set in the environment.
- Claim succeeds with JSON like `{"ok":true,"task":{"id":"task_...","status":"claimed","token":1}}`; keep `task.id` and `task.token` for artifact, heartbeat, complete, and fail commands.
- Use the fencing token returned by claim when completing or failing held work. If you lost it, inspect with `--json` and recover the current token before writing.
- Use your launch `scope_id` for normal same-scope follow-up work. Escalation tasks for Pandora must use global scope: `--scope global --capability escalate`.
- Scopes partition work queues. Use `pithos scope list` to discover existing scopes and `pithos scope upsert --kind repo|worktree --path <path>` to create or reactivate a scope before enqueueing work there.
- Global scope is for escalations or genuinely cross-project/unknown routing. Repo scope is good for project-level triage and design. Execution work should usually target a worktree scope so War can work in an isolated checkout.
- Creating a worktree scope records the path in Pithos; if the worktree directory does not exist yet, create it first with git/filesystem commands, then upsert the worktree scope and use the returned scope id for execute tasks.
- Pithos stores the full task graph; agents usually work the task chain reconstructed from it.
- A task chain is the inspectable history the user will review later: dependencies, source links, supersessions, artifacts, runs, and events together explain what happened.
- Dependencies gate claimability; source links are non-blocking provenance.
- For any Pithos command using `--stdin`, send exactly one stdin document; prefer quoted heredocs (`<<'EOF'`) and do not stage temp files solely for payload upload.
- Queue capabilities are `triage`, `design`, `execute`, and `escalate`; only enqueue capabilities listed in your launch context.
- Escalation is a normal global-scope task claimed by Pandora.

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

Enqueue with default auto chaining:

```sh
pithos task enqueue --run $PITHOS_RUN_ID --scope $PITHOS_SCOPE_ID --capability <triage|design|execute> --title '<title>' --stdin <<'EOF'
<task body>
EOF
```

Enqueue with `--chain none` (manual chaining):

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
