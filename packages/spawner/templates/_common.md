# Shared Pithos agent rules

- Pithos is durable truth for tasks, runs, claims, artifacts, events, and graph repair.
- Claim work with the rendered claim command before inspecting task body.
- A run may hold at most one task at a time.
- Use fencing token returned by claim/inspect when completing or failing held work.
- Attach useful artifacts before completing substantial work.
- Queue capabilities are `triage`, `design`, `execute`, and `escalate`.
- Escalation is a normal global-scope task claimed by Pandora.
- pdx owns lifecycle cleanup, interrupt, timeout, and kill policy.
