# Pithos harness hook contract

`pandora-spawn` keeps run liveness and run-finalization outside the harness binary itself.
Each supported harness supplies a tiny adapter that maps its native lifecycle hooks onto the shared dispatcher at [`hooks/dispatch.sh`](./hooks/dispatch.sh).

## Shared environment

`pandora-spawn` injects these environment variables into real harness sessions:

- `PITHOS_RUN_ID` — required
- `PITHOS_AGENT` — required
- `PITHOS_SCOPE_ID` — required
- `PITHOS_SESSION_ID` — required
- `PITHOS_TASK_ID` — optional
- `PITHOS_OUTPUT=json`

The dispatcher no-ops unless `PITHOS_RUN_ID` and `PITHOS_AGENT` are both present, so the same plugin/extension can stay installed for normal non-Pithos sessions.

## Shared hook events

Adapters only need to forward two logical events:

- `PreToolUse`
  - call: `hooks/dispatch.sh PreToolUse`
  - effect: `pithos heartbeat --run "$PITHOS_RUN_ID" --hook PreToolUse --throttle-seconds 60`
- `SessionEnd`
  - call: `hooks/dispatch.sh SessionEnd`
  - effect: `pithos run end --run "$PITHOS_RUN_ID" --status ended`

Unknown event names currently print a diagnostic message. Keep adapter wiring aligned with this document.

## Harness mappings

### Claude Code plugin

- native hook: `PreToolUse` → shared `PreToolUse`
- native hook: `SessionEnd` (`prompt_input_exit`) → shared `SessionEnd`

See [`claude-plugin/`](./claude-plugin/README.md).

### Pi extension

- native hook: `tool_call` → shared `PreToolUse`
- native hook: `session_shutdown` with `reason !== "reload"` → shared `SessionEnd`
- both are additionally gated on `ctx.sessionManager.getSessionId() === PITHOS_SESSION_ID`

Pi can replace the active session without exiting the process.
The session-id gate prevents replacement sessions from heartbeating or finalizing the wrong Pithos run, while `reload` stays a non-terminal event.

See [`pi-extension/`](./pi-extension/README.md).

## Status contract

`pandora-spawn status --session-id <id>` reads the harness transcript from the session log.
Today it auto-detects:

- Claude Code JSONL sessions under `~/.claude/projects`
- Pi JSONL sessions under `~/.pi/agent/sessions`

The launcher API stays the same across both tmux-backed harnesses.
