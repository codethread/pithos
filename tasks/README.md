# Task index

Machine-readable task dependency map lives in [`index.yml`](./index.yml).

Individual task files describe scope and acceptance only; blockers live in the YAML index.

## MVP follow-up notes

- Pithos top-level help now emits machine-readable JSON so nested command paths such as `pithos task artifact add` are represented directly; keep task-012b snapshots aligned with the JSON help surface.
- Keep verifying global bin links during demo gates. Root `pnpm run build` links `pdx` now; stale global npm links can otherwise point at another checkout and make pdx demos misleading.
- Consider pane-visible pdx daemon logs after MVP basics: structured JSONL remains source of truth, but `pdx--daemon` could tee supervisor log lines to stderr so humans attaching to the daemon tmux window see startup/reconcile/cleanup activity live.

## Stdin payload API change plan

### Problem statement / MVP goal

Implement the pending Pithos stdin payload CLI contract so payload-bearing Task mutations use explicit `--stdin` instead of payload/file flags. The MVP keeps Pithos as durable source of truth, preserves existing Task/Run/Artifact invariants, and updates agent-facing docs/prompts once behavior is complete.

### Important references

- `specs/pithos-stdin-payload-api-change.md`
- `specs/control-plane-supervision.md`
- `specs/task-graph.md`
- `specs/control-plane-design-notes.md`
- `UBIQUITOUS_LANGUAGE.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/services.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
- `packages/spawner/templates/`

### Task strategy

Tasks 015-018 are AFK vertical slices through the public `pithos` CLI, service boundary, engine-facing inputs, behavior tests, and the normative command-contract text for the command each slice changes. Task 015 introduces the shared stdin/input service through the enqueue path. Tasks 016-018 reuse that boundary for supersede, artifact add, and complete. Task 019 is blocked on behavior slices and performs the final status/docs/prompts audit so no conflicting payload contract remains.

No HITL slice is required: the stdin payload decisions are already captured in the pending change spec, and the normative specs identify the exact command-contract sections to update.

## Automatic task chaining and source-link plan

### Problem statement / MVP goal

Implement automatic task-chain preservation so agents create durable work threads instead of flat task islands. The MVP adds `pithos task enqueue --chain auto|none|held|source`, records non-blocking source links for escalations, routes Pandora escalation-resolution handoffs back to the source task, and updates prompts/docs so routine agents rely on default auto chaining.

The product goal is not to teach graph theory. Pithos stores a full task graph for historical interrogation; agents and Adam talk about task chains as the delegation story reconstructed from that graph.

### Important references

- `specs/task-graph.md`
- `specs/control-plane-supervision.md`
- `UBIQUITOUS_LANGUAGE.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/src/db.ts`
- `packages/pithos/src/rows.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/spawner/templates/_common.md`
- `packages/spawner/templates/pandora.md.tmpl`
- `packages/spawner/templates/toil.md.tmpl`
- `packages/spawner/templates/greed.md.tmpl`
- `packages/spawner/templates/war.md.tmpl`
- `packages/pithos/README.md`

### Task strategy

Tasks 023-027 are AFK slices through pure graph policy, CLI, engine, DB relationships, read surfaces, events, and tests. Task 023 creates a pure in-memory graph/chain policy core with broad fast tests before any DB wiring. Task 024 establishes the flag/output contract. Task 025 implements ordinary held-task dependency continuation. Task 026 adds source links for immediately-claimable escalations. Task 027 completes the Pandora handoff from held escalation back to source work. Task 028 is blocked on behavior and updates prompts/docs after the CLI contract exists.

No HITL slice is required: Adam confirmed the core language and prompt-surface decisions. Routine prompts should teach default auto plus explicit `--chain none`; `--chain held` and `--chain source` remain advanced/fail-loud CLI modes rather than normal recipes.

## Developer Notes

Append notes here. Do not rewrite earlier notes.

### Task 028: Auto-chain docs and prompts — 2026-05-11

- Prompt contract now teaches default auto chaining for routine follow-up, `--chain none` for unrelated work, manual `--depends-on` only for extra fan-in, and `--chain none --depends-on <task-id>` for manual-only handoffs.
- Pandora Q convention is explicit: unrelated Qs while holding an escalation use `--chain none`; source-resolution handoffs use default auto; “Q this for task_X” uses manual-only dependency form.
- Pithos README documents source links as non-blocking provenance, dependencies as claimability gates, and enqueue chain output metadata.
- Validation run: `pnpm typecheck && pnpm lint && pnpm test && pnpm run build`.
- Deep-review follow-up clarified Pithos task id wording in Pandora Qs, marked the task-graph spec implemented, and updated graph/chain help text to name source links and fail-loud held/source modes.

### Task 027: Escalation source handoff — 2026-05-11

- Confirmed the existing pure chain resolver and DB enqueue path already route Pandora-held sourced escalations through `depends_on_source`; added DB-backed lifecycle coverage for Pandora handoff metadata/events and dependency rows.
- Added integration coverage for explicit `--chain source`, sourced-escalation `--chain none` manual-only behavior, escalation-without-source visible no-op metadata, escalation-from-escalation visible no-op metadata, and fail-loud `--chain source` preconditions.
- Tightened escalation-from-escalation no-op metadata so it does not carry the held escalation source as a relationship-looking source id.
- Validation run: `pnpm typecheck && pnpm lint && pnpm test && pnpm run build`.

### Task 026: Escalation source links — 2026-05-11

- Added durable `task_sources` storage and wired default auto chaining so held ordinary work enqueueing an escalation records a non-blocking source link rather than a dependency.
- `task inspect` now returns the direct source summary; dependency lineage remains dependency-only. `graph inspect` JSON now closes over source edges/nodes and includes `source_task_id` on nodes.
- Added lifecycle coverage for source persistence, enqueue/event metadata, graph output, lineage exclusion, immediate Pandora claimability while the source is still claimed, and fail-loud superseded-source validation.
- Validation run: `pnpm typecheck && pnpm lint && pnpm test && pnpm run build`.

### Task 025: Auto dependency chain continuation — 2026-05-11

- Wired enqueue's DB path to resolve the actor run's held task after authorization and feed it through the pure chain-policy resolver, enabling default `--chain auto` and explicit `--chain held` to add blocking dependencies for ordinary follow-up work.
- Enqueue output and `task.created` chain metadata now include `implicit_dependency_ids` so implicit held-task chaining is distinguishable from flat/manual-only enqueue.
- Added lifecycle coverage for claim blocking until the held upstream task is completed, lineage/dependency inspection, manual fan-in, duplicate final dependency rejection, and explicit held precondition failures.
- Validation run: `pnpm typecheck && pnpm lint && pnpm test && pnpm run build`.

### Task 024: Enqueue chain flag baseline — 2026-05-11

- Added `pithos task enqueue --chain auto|none|held|source` with CLI-boundary validation, default `auto`, and chain metadata in enqueue output plus `task.created` payloads.
- Wired enqueue through the pure chain-policy resolver for the no-held baseline; `--chain none --depends-on <task-id>` remains manual-only and source-link storage / held-task implicit edges remain later-slice work.
- Validation run: `pnpm typecheck && pnpm --filter @pithos/pithos test`; `pnpm lint && pnpm test && pnpm run build`.

### Task 023: Pure chain graph policy core — 2026-05-11

- Added `packages/pithos/src/chain-policy.ts` as a pure, DB-free resolver/helper module for automatic chaining decisions, dependency duplicate detection, dependency cycle checks, source-excluding dependency lineage, unresolved dependency blockers, and closure over dependency/source/supersession neighbors.
- The pure test suite covers the `auto`/`none`/`held`/`source` matrix and source-vs-dependency semantics without SQLite; later slices can wire the resolver into enqueue persistence.
- Validation run: `pnpm typecheck && pnpm lint && pnpm test && pnpm run build`.

### Task 023-028: Automatic task chaining plan — 2026-05-11

- Plan added after updating `UBIQUITOUS_LANGUAGE.md` and `specs/task-graph.md` to define Task graph, Task chain, Source link, and Attached context.
- Existing `tasks/index.yml` uses repository-local `task-###` ids and mixed `file`/`task_file` fields rather than the generic integer-id schema, so new slices preserve the established plan format for compatibility.
- No HITL task is needed: Adam confirmed `source` over `relates_to`, and confirmed the agent prompt surface should be default auto plus `--chain none` mainly for Pandora.
- Adam requested lots of graph-side tests because this is mostly pure data behavior. Added task 023 as an explicit pure in-memory graph/chain policy core with broad fast Vitest coverage before DB/CLI slices.
- Keep task 028 blocked until behavior exists; do not update agent prompts to mention `--chain` before the CLI supports it.

### Task 015-019: Stdin payload API plan — 2026-05-10

- Plan was added after reading `specs/pithos-stdin-payload-api-change.md`, `specs/control-plane-supervision.md`, `specs/task-graph.md`, `specs/control-plane-design-notes.md`, `specs/README.md`, `UBIQUITOUS_LANGUAGE.md`, and pithos CLI/service/test context.
- Existing `tasks/index.yml` uses the repository's established `task-015` string-id dependency style rather than integer ids; new stdin tasks keep that id style but use the requested `description` and `task_file` fields for AFK loop consumption.
- Task 015 is intentionally blocked by completed concrete prerequisite `task-013c`, not epic `task-013`, so the stdin payload work is the next runnable AFK task while older pending follow-up tasks remain blocked on the epic placeholder.
- Deep review found that delaying all spec sync to task 019 would leave implemented behavior conflicting with normative specs. Tasks 015-018 now each require updating command-contract text for the command they change; task 019 remains the final audit/status/docs/prompts sync.

### Task 015: Enqueue stdin payload CLI slice — 2026-05-10

- Added the shared Pithos input service with typed stdin states and wired `task enqueue --stdin` through the CLI boundary before calling the existing engine string-body API.
- Updated enqueue command-contract specs to remove `--body`/`--body-file` from current enqueue behavior; supersede/artifact/complete payload flags remain for their later slices.
- Validation run: `pnpm verify`.

### Task 016: Supersede stdin replacement body — 2026-05-10

- `task supersede` now resolves replacement body from explicit `--stdin` at the CLI boundary and emits tagged validation JSON before config/DB access when `--stdin` is omitted or invalid.
- Public supersede CLI no longer defines `--body` or `--body-file`; the in-process engine API still accepts explicit body/bodyFile for non-CLI callers while the CLI always passes stdin text.
- Updated normative supersede command contracts in `control-plane-supervision.md` and `task-graph.md`.
- Validation run: `pnpm verify`.

### Task 017: Artifact add stdin body — 2026-05-10

- `task artifact add` now requires explicit `--stdin`, resolves artifact body through the typed input service before config/DB access, and passes resolved body text to the engine.
- Public artifact add CLI no longer defines `--body-file`; engine artifact add no longer has file-path indirection or empty-body omission behavior.
- Updated artifact add command contracts in `control-plane-supervision.md` and `control-plane-design-notes.md`.
- Validation run: `pnpm verify`.

### Task 018: Complete stdin result metadata — 2026-05-10

- `task complete` now defaults to `{}` without touching the input service, and `--stdin` reads once at the CLI boundary before passing resolved result metadata to the engine.
- Public complete CLI no longer defines `--result-file`; stdin metadata must parse as a JSON object and non-object JSON is rejected with tagged validation JSON.
- Updated complete command contracts in `control-plane-supervision.md` and `control-plane-design-notes.md`.
- Validation run: `pnpm verify`.

### Task 019: Stdin payload docs and prompts sync — 2026-05-10

- Marked the stdin payload API spec implemented and aligned command contract notes across supervision/design specs and Spawner templates.
- Updated demos to use explicit `--stdin` payload pipes; refreshed the backbone demo run upserts with required transcript metadata while auditing the touched demo.
- After review, updated touched pdx docs to the current nested `pdx daemon ...` command surface and added a bundled-template regression test for the stdin payload prompt contract.
- Validation runs: `pnpm verify`; `PITHOS_BIN=packages/pithos/bin/pithos bash docs/demos/pithos-backbone.sh`; post-review `pnpm verify`.
