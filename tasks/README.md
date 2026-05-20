# Task Plans

## Problem statement / MVP goal

The completed first plan implemented the scoped `review` capability change. The current follow-up MVP implements the typed-edge Task graph redesign now folded into `specs/task-graph.md` and `specs/control-plane-supervision.md`.

The typed-edge MVP replaces split Dependency/Source-link storage with a single typed edge model, adds dynamic `gate` coordination edges that wait for an evolving branch to drain, and folds escalation/Repair Alert routing into ordinary graph semantics through `about` and `repair` edges. The work is accepted as a breaking pre-v1 DB/CLI change.

## Important references

- `specs/task-graph.md` — canonical durable typed-edge Task graph semantics.
- `specs/control-plane-supervision.md` — canonical escalation/Repair Alert and pdx integration semantics.
- `UBIQUITOUS_LANGUAGE.md` — canonical domain terminology.
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

### Task 9 implementation — 2026-05-20

- Added typed `gate` graph edges with inspection state/members, scope graph closure over `after`/`about`/`repair` branch membership plus `gate` coordination edges, and late-growth marker visibility in task/graph output.
- Readable task/graph/briefing output now separates direct after blockers, attached about/repair context, coordination gates, broken/open gate members, Supersession, and allowed late branch growth.
- Added renderer snapshots for major typed-edge graph display variants and DB-backed coverage proving scoped repo graph inspection pulls attached global attention/checkpoint tasks.
- Simplification pass kept late-growth output as the existing parsed DB row shape instead of adding a parallel DTO/mapper.
- Validation: `pnpm verify` passed.

### Task 8 implementation — 2026-05-20

- Added `task_gate_late_growth_markers` and a public Pithos read-model helper for marker rows with gate release, mutation, actor, and timestamp fields for Task 9 rendering.
- Edge insertion for `after`/`about`/`repair` and Supersession now checks affected released gates in the same SQLite transaction, fails loudly while downstream impact closure has non-terminal tasks, and records markers when impact is terminal.
- Regression coverage added for direct released gates, transitive released gates, Supersession under released gates, allowed terminal late growth marker writes, and rollback of failed late edge attempts.
- Validation: `pnpm verify` passed.

### Task 7 implementation — 2026-05-20

- Added explicit `--gate-on` enqueue support and `gate` edge insertion with duplicate/current-target validation.
- Claimability now canonicalizes superseded `after` targets and evaluates queued tasks against dynamic gate branch closures over incoming `after`/`about`/`repair` edges; gate states are exposed in task inspect read-model output as `clear`, `open`, or `broken`.
- Claim writes per-attempt `task_gate_releases` and `task_gate_release_members` rows in the Claim transaction and emits `task.gate_released` with attempt, fencing token, run id, and member snapshot ids.
- Enqueue graph integrity now rejects gate owners already inside target closure and blocking cycles across `after`/`gate`; Supersession retargets queued `after` and `gate` dependents by kind.
- Held checkpoint escalation continuation now follows the existing held-escalation continuation path by treating held `gate` escalation as chain-source-like for policy resolution.
- Validation: `pnpm verify` passed.

### Task 6 implementation — 2026-05-20

- Public enqueue now exposes typed non-gate edge flags: repeatable `--after`, singular `--about`, and pdx-system-only `--repair`; the old `--depends-on` flag and `--chain source` policy are rejected.
- Automatic chain policy now writes typed edges: ordinary continuations use `after`, ordinary-to-escalation uses `about`, about-escalation continuations depend on the held escalation, and repair-escalation continuation fails loudly with supersede/replan/cancel guidance.
- Enqueue validates duplicate `after` targets, superseded edge targets, mutually exclusive attention edges, and branch-membership acyclicity across `after`/`about`/`repair` inside the creation transaction.
- CLI/help/tests were updated for the new edge surface; pdx call sites now pass `after` to the Engine boundary.
- Smoke checks used an isolated real SQLite DB and real Pithos CLI commands for `--after`, `--about`, system `--repair`, removed flag rejection, removed chain policy rejection, and help JSON.
- Validation: `pnpm verify` passed.

### Task 5 implementation — 2026-05-20

- Fresh Pithos schema now stores dependencies/provenance in `task_edges` with `after`, `about`, `repair`, and `gate` kinds; `task_dependencies` and `task_sources` are no longer created.
- Existing public enqueue flags are preserved for this storage slice: `--depends-on` writes `after`, automatic escalation provenance writes `about`, and Repair Alerts write `repair`.
- Claimability still checks only unresolved outgoing `after` edges; `gate` storage is present but intentionally inert until the gate claimability slice.
- Supersession rewires queued direct `after` dependents to replacements and keeps `about`/`repair` provenance attached to the original task.
- `task.created` payloads now include `edges: { after, about, repair, gate }`; legacy `depends_on_task_ids`/source payload fields were removed from new events.
- YAGNI follow-up removed premature gate-release tables and duplicate source fields from graph nodes; Task 5 keeps only storage needed for the tracer-bullet edge model.

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

- Added Tasks 5–11 for the typed-edge Task graph redesign that was initially captured in the temporary typed-edge diff spec, now folded into canonical specs.
- The plan intentionally preserves completed review tasks and appends the new work with new integer ids.
- Task 9 explicitly requires broad snapshot tests for readable `graph inspect` variations so future display changes are obvious in diffs and can be intentionally accepted with `vitest run --update`.
- Deep-review follow-up tightened standalone AFK ownership: Task 5 owns `task.created` typed-edge event payloads, Task 6 owns `after/about/repair` membership cycle tests and system-only `repair` edges, Task 7 owns checkpoint escalation continuation plus invalid gate-closure/cycle checks plus `task.gate_released`, Task 8 now requires durable `task_gate_late_growth_markers` instead of choosing between marker/event, and Task 9 renders that marker.

### Task 10 implementation — 2026-05-20

- Folded the typed-edge diff spec into canonical Task graph, control-plane, ubiquitous-language, package, resource, and agent-template docs.
- Removed the temporary typed-edge diff spec from the specs index and filesystem.
- Updated Spawner command-card annotations/tests so rendered agent prompts describe typed edges, gates, and repair context instead of removed dependency/source-link surfaces.
- Validation: `pnpm verify` passed.

### Task 11 verification — 2026-05-20

- Validation passed: `pnpm verify`; `pnpm --filter @pdx/pithos test -- test/foundation.test.ts test/chain-policy.test.ts test/task-lifecycle.test.ts test/render.test.ts test/cli.test.ts`; `pnpm --filter @pdx/pdx test -- --run`; `pnpm --filter @pdx/spawner test -- --run`.
- Isolated smoke passed with temp `PITHOS_DB`, `PDX_DATA_DIR`, and `PDX_USER_DATA_DIR`: `pithos init --fresh`, `pdx init`, Pithos help surfaces, and War/Pandora `pandora-spawn preview` typed-edge prompt checks.
- No temporary typed-edge diff spec remains in `specs/` or `specs/README.md`; no repairs or snapshot updates were needed.
