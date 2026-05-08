# Slice 8b — Registry cap accounting

## What to build

Add cap enforcement to non-Pandora spawning from task 008a.

Caps:

- Per `(agent_kind, scope_id)`: max one Registry entry for spawnable agents.
- Global `--max-afk`: max live/launching/terminating AFK entries across spawnable agents.
- Caps count Registry states `launching`, `live`, and `terminating`.
- Pandora and the `pdx` system run are excluded from these cap calculations.

Implementation rules:

- Registry state is the cap source of truth, not DB run status.
- Cap checks occur before launch.
- Cap slots are released only when the Registry entry is removed after natural cleanup or completed kill settlement.
- Side effects happen outside Registry locks; never hold the Registry ref while launching/killing/logging.

## Test focus

- Per `(agent, scope)` cap blocks a second spawn while an entry is `launching`.
- Same cap blocks while entry is `live`.
- Same cap blocks while entry is `terminating`.
- Cap releases after entry removal.
- Global `--max-afk` cap blocks additional AFK spawns.
- Pandora and `pdx` system run do not consume non-Pandora caps.

## Defer

- PID file writes/removal; task 008c.
- No-claim timeout; task 008d.
- More complex fairness or priorities; out of MVP scope.

## Acceptance criteria

- [ ] Per-agent/scope cap enforced from Registry
- [ ] Global AFK cap enforced from Registry
- [ ] `launching`, `live`, and `terminating` all count
- [ ] Pandora and `pdx` exclusions tested
