# Slice 3 — Task graph tightening + DEMO GATE 1

## What to build

Tighten the existing Pithos graph rules in `packages/pithos/` to match the locked spec, and stand up a demo walkthrough so Adam + an agent can validate the full Pithos backbone end-to-end.

Validation tightening:

- `task enqueue --capability escalate` rejects unless `scope_id = global`. `task supersede` applies the same rule to the replacement task after overrides — escalations are global-only by data shape.
- `task supersede --scope <other>` is rejected when the old task has any queued direct dependents (would force cross-scope retarget). Allowed only when no queued direct dependents would be retargeted.
- All other supersede preconditions per spec §6 hold:
  - `claimed` and `running` rejected; use `pdx kill` / `pithos run interrupt` first
  - single-supersede only (a task may be superseded at most once)
  - direct dependents in any state other than `queued` or `cancelled` cause supersede to fail loudly
  - direct queued dependents are rewired; cancelled dependents ignored
  - if old task was `queued` it becomes `cancelled` in the same transaction
- Consolidated event vocabulary per spec §11 emitted with required minimum fields across the lifecycle.

## Demo gate

This slice is the first demo gate. After this slice merges, Adam + an agent must be able to walk through the entire Pithos backbone via the CLI alone. Commit a replayable demo script (e.g. `docs/demos/pithos-backbone.md`) that exercises:

- `pithos init --fresh`, scope upserts (global + a repo scope), run upserts simulating each agent kind
- `task enqueue` for triage / design / execute / escalate (respecting authorization and scope rules)
- claim → heartbeat → complete happy path, and claim → fail unhappy path
- `run cleanup`, `run interrupt`, `run timeout` simulation
- `task supersede` of a failed task; verify queued direct dependents retargeted; verify cross-scope supersede rejection
- `task cancel` of a queued task
- `pithos events tail`, `pithos graph inspect`, `pithos task inspect`, `pithos briefing` reflecting state at each step

Demo must not use raw SQL.

## Test focus

- `task enqueue --capability escalate --scope <non-global>` rejected
- `task supersede` cross-scope override + queued dependents → rejected
- `task supersede` cross-scope override + no dependents → allowed
- All existing supersede preconditions still hold (claimed/running rejected, single-supersede rejected, mixed-dependent-state rejected)
- Demo script runs end-to-end without manual SQL or test fixtures

Defer: graph-rendering output formatting beyond JSON shape minimums; exhaustive payload field tests.

## Implementation primitives

Reuses task-001 §Implementation primitives for SQL/transactions. New only:

- Capability-scope validation runs on both `task enqueue` and `task supersede` (after override resolution). Centralise in one `validateCapabilityScope(scope, capability)` Effect both call sites invoke.
- Supersede rewires queued direct dependents in one UPDATE; cross-scope rejection is a precondition check before any mutation.
- Demo script is a shell-runnable `.md`-with-fenced-bash; uses only the public CLI surface, not raw SQL.

## Acceptance criteria

- [ ] Capability scope rules enforced for enqueue and supersede
- [ ] Supersede cross-scope rule enforced when queued dependents would be retargeted
- [ ] Existing supersede preconditions remain enforced
- [ ] Consolidated event vocabulary emitted per spec §11
- [ ] Demo script committed and runs end-to-end
- [ ] Adam + agent walk through demo and confirm Pithos backbone behaves as specced (human-verified, not CI-checkable; record confirmation as a comment on this issue)
