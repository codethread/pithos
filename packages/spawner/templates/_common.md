# Shared Pithos agent rules

- Pithos is durable truth for tasks, runs, claims, artifacts, events, and graph repair.
- Claim work with the rendered claim command before inspecting task body.
- A run may hold at most one task at a time.
- Use fencing token returned by claim/inspect when completing or failing held work.
- Attach useful artifacts before completing substantial work: `printf '%s\n' '<artifact body>' | pithos task artifact add --task <task-id> --run <run-id> --kind <kind> --title <text> --stdin`.
- Complete with `pithos task complete <task-id> --run <run-id> --token <token>` for default `{}` metadata; use `--stdin` only for JSON object metadata.
- Enqueue or supersede payloads with exactly one stdin document and explicit `--stdin`; do not stage temp files solely for Pithos payload upload.
- Queue capabilities are `triage`, `design`, `execute`, and `escalate`.
- Escalation is a normal global-scope task claimed by Pandora.
- pdx owns lifecycle cleanup, interrupt, timeout, and kill policy.
