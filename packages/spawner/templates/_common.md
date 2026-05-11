## Shared Pithos operating rules

- Pithos is durable truth for tasks, runs, claims, artifacts, events, and graph repair.
- Claim work with the rendered claim command before inspecting task body.
- A run may hold at most one task at a time.
- `PITHOS_BIN` points at the configured Pithos binary; `PITHOS_RUN_ID`, `PITHOS_SCOPE_ID`, and `PITHOS_DB` are set in the environment.
- Claim succeeds with JSON like `{"ok":true,"task":{"id":"task_...","status":"claimed","token":1}}`; use `task.id` and `task.token` for inspect, artifact, complete, fail, and heartbeat commands.
- If claim returns `NO_CLAIMABLE_WORK`, do not invent work or poll in a loop. AFK agents should exit cleanly; HITL agents should wait for Adam or a control-plane wakeup.
- Use fencing token returned by claim/inspect when completing or failing held work.
- Use your launch `scope_id` for normal follow-up work. Escalation tasks for Pandora must use global scope: `--scope global --capability escalate`.
- For normal downstream work that should wait for the held task to finish, enqueue with `--depends-on <held-task-id>`. Do not put `--depends-on <held-task-id>` on an escalation that must be claimable while you still hold the current task.
- Attach useful artifacts before completing substantial work. Artifact `--kind` is a short category; use conventions such as `triage`, `design-brief`, `war-completion`, `decision`, or `evidence`.
- For any Pithos command using `--stdin`, send exactly one stdin document; prefer quoted heredocs (`<<'EOF'`) and do not stage temp files solely for payload upload.
- Queue capabilities are `triage`, `design`, `execute`, and `escalate`; only enqueue capabilities listed in your launch context.
- Escalation is a normal global-scope task claimed by Pandora.
- pdx owns lifecycle cleanup, interrupt, timeout, and kill policy.

## Common command recipes

After claiming, inspect the held task:

```sh
$PITHOS_BIN task inspect <task-id>
```

`task inspect` includes upstream dependency lineage and ancestor artifacts. Prefer referencing upstream task/artifact ids from that lineage instead of copying approved briefs into downstream task bodies.

Attach an artifact with a stdin body:

```sh
$PITHOS_BIN task artifact add --run $PITHOS_RUN_ID --kind <kind> --title '<title>' --stdin <task-id> <<'EOF'
<artifact body>
EOF
```

Complete with default `{}` metadata:

```sh
$PITHOS_BIN task complete --run $PITHOS_RUN_ID --token <token> <task-id>
```

Fail with a reason:

```sh
$PITHOS_BIN task fail --run $PITHOS_RUN_ID --token <token> --reason '<reason>' <task-id>
```

Enqueue follow-up work with a body:

```sh
$PITHOS_BIN task enqueue --run $PITHOS_RUN_ID --scope $PITHOS_SCOPE_ID --capability <triage|design|execute> --title '<title>' --stdin --depends-on <held-task-id> <<'EOF'
<task body>
EOF
```

Enqueue an escalation for Pandora while you still hold the current task:

```sh
$PITHOS_BIN task enqueue --run $PITHOS_RUN_ID --scope global --capability escalate --title '<title>' --stdin <<'EOF'
<what Adam/Pandora needs to know>
EOF
```
