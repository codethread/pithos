# Task Plans

## Problem statement / MVP goal

The completed first plan implemented the scoped `review` capability change. The current follow-up MVP implements the planned typed-edge Task graph redesign from `specs/task-graph-typed-edges-diff.md`.

The typed-edge MVP replaces split Dependency/Source-link storage with a single typed edge model, adds dynamic `gate` coordination edges that wait for an evolving branch to drain, and folds escalation/Repair Alert routing into ordinary graph semantics through `about` and `repair` edges. The work is accepted as a breaking pre-v1 DB/CLI change.

## Important references

- `specs/task-graph-typed-edges-diff.md` — planning diff overlay and primary contract for Tasks 5–11.
- `specs/task-graph.md` — current durable Task graph semantics to replace/fold into.
- `specs/control-plane-supervision.md` — current escalation/Repair Alert and pdx integration semantics to update.
- `UBIQUITOUS_LANGUAGE.md` — domain terminology to update after implementation.
- `packages/pithos/src/db.ts` — schema and seeded durable contracts.
- `packages/pithos/src/chain-policy.ts` — enqueue policy and implicit edge behavior.
- `packages/pithos/src/engine.ts` and `packages/pithos/src/engine/*` — Task transitions, claim loop, read models, graph inspection, renderers, Repair Alerts, and events.
- `packages/pithos/test/` — behavior, CLI, render, lifecycle, and graph tests; Task 9 should add broad snapshot coverage for readable graph variations.
- `packages/pdx/src/` and `packages/pdx/test/` — Repair Alert call sites and command-card/supervision integration affected by CLI changes.
- `packages/spawner/src/` and `resources/data-dir/templates/` — agent prompt/command-card surfaces that must stop using removed flags.
- Earlier completed review-capability references remain in Tasks 1–4 and the Developer Notes history below.

## Task strategy

Tasks 1–4 are complete and belong to the previous scoped-review plan. Tasks 5–11 are the typed-edge implementation plan.

The new plan is split into AFK vertical slices. Task 5 changes storage while preserving existing behavior. Task 6 exposes the non-gate typed-edge enqueue surface and chain-policy changes. Task 7 adds dynamic gate claimability and release snapshots. Task 8 enforces late-growth protection after gate release. Task 9 makes typed edges and gates visible to agents, with broad snapshot tests for readable graph display variations. Task 10 folds the temporary diff spec into canonical docs and prompts. Task 11 performs full verification and repair.

No HITL slices are required: the user has accepted the breaking-change direction, gate semantics, escalation unification, and the need for snapshot-heavy graph display coverage.

## Developer Notes

Append notes here. Do not rewrite earlier notes.

### Task plan amendment — 2026-05-17

- Deep review found that adding `review` to Greed claims affects pdx launch policy and Spawner claim rendering, not only Pithos built-ins. Task 1 now explicitly includes pdx/Spawner integration and tests.
- Task 2 now carries the prompt-only scope policy, global review payload requirements, rejected-review outcome behavior, and preview validation.
- Task 3 now includes the root `README.md` in permanent docs fold-in.

### Task 1 implementation — 2026-05-17

- Added `review` as a built-in Capability, Greed claim, and Pandora/Toil enqueue target; kept Greed/War/Envy unauthorized for `review` enqueues and Pandora/Toil/War/Envy unauthorized for `review` claims.
- pdx now treats claimable `design` and `review` work as Greed launches and passes the launch-selected Capability through to Spawner.
- Spawner now requires an authorized `selectedCapability` for multi-claim agents and renders the deterministic claim command for that Capability.
- `review` uses ordinary chain-policy dependency behavior; `escalate` remains the only source-link special case.

### Task 2 implementation — 2026-05-17

- Canonical prompts now document `review` as explicitly requested Greed-owned HITL assessment, not an automatic gate.
- Greed prompt has separate design/review modes, including review readiness escalation, review-report artifact, rejected-outcome handling, and no-substantial-implementation boundary.
- Pandora and Toil prompts can enqueue requested review tasks with narrowest-useful-scope guidance and global review payload requirements.
- `pandora-spawn preview` succeeded for Greed (`review` selected), Pandora, and Toil in an isolated PDX/Pithos data configuration.
- Validation: `pnpm verify` passed. A flaky live ID format assertion was broadened to allow hyphenated word-list entries such as `yo-yo`.

### Task 3 implementation — 2026-05-17

- Folded `review` into permanent terminology and base specs as Greed-claimed, explicitly requested, ordinary non-escalation work.
- Updated control-plane docs with Greed review launch/lifecycle and readiness escalation to Pandora.
- Removed the temporary scoped review change spec from the specs index and filesystem.
- Validation: `pnpm verify` passed.

### Task 4 verification — 2026-05-17

- Isolated `pandora-spawn preview` succeeded for Greed with `--selected-capability review`, Pandora, and Toil after fresh `pithos init --fresh` and `pdx init` in temp data/user dirs.
- `pnpm verify` passed from the repo root.
- No temporary scoped review spec remains under `specs/`; no integration repairs were needed.

### Typed edge task plan amendment — 2026-05-19

- Added Tasks 5–11 for the typed-edge Task graph redesign captured in `specs/task-graph-typed-edges-diff.md`.
- The plan intentionally preserves completed review tasks and appends the new work with new integer ids.
- Task 9 explicitly requires broad snapshot tests for readable `graph inspect` variations so future display changes are obvious in diffs and can be intentionally accepted with `vitest run --update`.
- Deep-review follow-up tightened standalone AFK ownership: Task 5 owns `task.created` typed-edge event payloads, Task 6 owns `after/about/repair` membership cycle tests and system-only `repair` edges, Task 7 owns checkpoint escalation continuation plus invalid gate-closure/cycle checks plus `task.gate_released`, Task 8 now requires durable `task_gate_late_growth_markers` instead of choosing between marker/event, and Task 9 renders that marker.
