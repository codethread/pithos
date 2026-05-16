# AFK task plan

## Problem statement / MVP goal

Tasks 1–5 completed the graph-inspection MVP. The active follow-up is to implement the planned Agent command-reference rendering contract in `specs/agent-command-reference.md`: keep dynamic `{{command_cards}}`, stop injecting raw JSON, render concise role-filtered Markdown from CLI metadata, and include Pandora-facing guidance for the implemented graph views.

The MVP should make bundled templates render, preserve fail-loud help/annotation validation, and give Pandora enough generated prompt context to use `pithos briefing` and `pithos graph inspect` correctly during sitrep and repair work.

## Important references

- `specs/agent-command-reference.md` — planned command-reference rendering contract and annotation requirements.
- `specs/task-graph.md` — authoritative graph-inspection contract, including filters, seed-before-closure behavior, readable output, and the `repair_source` scope-graph exception.
- `specs/control-plane-supervision.md` — control-plane template context and role-filtered command reference contract.
- `templates/README.md` — template manifest, include, overlay, and variable contract.
- `templates/AGENTS.md` — direct template-config editing guide.
- `templates/pandora.md` — Pandora sitrep and graph/briefing prompt flow.
- `templates/agents.json` — built-in Agent manifest and include lists.
- `packages/spawner/README.md` — Spawner package boundary and preview behavior.
- `packages/spawner/src/spawner.ts` — current command-card render pipeline and role filters.
- `packages/spawner/src/spawner.test.ts` — render/launch/manifest behavior tests.
- `packages/pithos/src/cli.ts` and `packages/pdx/src/main.ts` — `--help-json` producers consumed by Spawner.

## Task strategy

Tasks 1–5 are complete historical graph-inspection slices and remain in the queue for provenance. Tasks 6–12 add the command-reference implementation as a new linear AFK follow-up:

1. Restore bundled template renderability by resolving missing guard includes before changing command-card behavior.
2. Replace raw JSON command-card output with generated Markdown while keeping role filters and fail-loud path validation.
3. Add validated command annotations for core task lifecycle commands.
4. Add Pandora-specific graph/briefing guidance so the new graph views are visible in her generated prompt reference.
5. Converge templates, package docs, and specs after the code matches the planned contract.
6. Run an explicit spec/code alignment pass so the durable specs tell the truth about the implemented feature.
7. Preview all generated built-in prompts and make small readability fixes so the command reference supports each Agent role and Pandora's graph/sitrep work.

No HITL slices are required. The remaining choices are already constrained by `specs/agent-command-reference.md` and `specs/task-graph.md`; each slice has deterministic local validation through Spawner tests and docs formatting.

## Developer Notes

Append notes here. Do not rewrite earlier notes.

### Task 1: Truthful graph rendering — 2026-05-16

- This plan replaces `tasks/index.yml` with the active AFK queue requested for graph inspection work. Older `tasks/task-*` files remain in the repository as historical archive files but are intentionally unreferenced by this queue.
- Removed `--hide-terminal` from the graph inspect CLI and engine input; unknown-flag parser failure is now the contract for that removed surface.
- Readable graph rendering now emits every node in the selected closed graph. Existing seed selection still excludes stale cancelled tasks for `--scope`/`--all`; task-rooted inspection remains available for those nodes.
- Validation: `pnpm verify` passed.
- Deep-review noted readable output still does not label source-link edges; that is pre-existing graph text structure rather than terminal-node pruning and should be considered with the later graph inspect docs/convergence work if product wants source edges rendered explicitly.

### Task 2: Graph status seed filter — 2026-05-16

- Added repeatable literal `--status` filters for `pithos graph inspect`; invalid values fail before DB config is loaded with tagged `VALIDATION_ERROR` JSON.
- Status filters apply only to seed selection. Dependency/source/supersession closure still includes related non-matching context nodes.
- Validation: `pnpm verify` passed.

### Task 3: Graph search seed filter — 2026-05-16

- Added repeatable `--search` filters for `pithos graph inspect`; whitespace-only terms fail before DB config is loaded with tagged `VALIDATION_ERROR` JSON.
- Search filters only seed from task title/body text and compose with repeated-term AND plus existing selector/status filters. Closure still adds non-matching dependency/source/supersession context.
- Validation: `pnpm verify` passed.

### Task 4: Graph since seed filter — 2026-05-16

- Added `--since` for `pithos graph inspect` with exact supported forms: `today`, `<n>h`, `<n>d`, `YYYY-MM-DD`, and ISO timestamps with timezone.
- `today`/date-only cutoffs use local operator-day midnight; relative forms use the injected Pithos clock. The filter matches `created_at`, `updated_at`, or `completed_at` before graph closure, so related context can still appear.
- Validation: `pnpm verify` passed.

### Task 5: Graph inspect docs convergence — 2026-05-16

- Folded the implemented graph inspect contract into `specs/task-graph.md`: truthful readable output, no `--hide-terminal`, seed-first `--status`/`--search`/`--since` filters, and `briefing` as the agenda surface.
- Marked `specs/pithos-graph-inspection.md` as implemented/folded and updated the spec index so `task-graph.md` is the authoritative graph-inspection contract.
- `packages/pithos/README.md` already matched generated-help guidance and truthful graph rendering, so no package README change was needed.
- Validation: `pnpm verify` passed.
- Deep-review/YAGNI follow-up aligned `specs/control-plane-supervision.md`, narrowed readable graph wording to avoid claiming readable source-edge rendering, and collapsed `specs/pithos-graph-inspection.md` to a pointer so the graph inspect contract has one authoritative home.

### Task 6: Template guard renderability — 2026-05-16

- Added tasks 6–12 as a new AFK follow-up plan after graph inspection tasks 1–5 completed. The new slices implement `specs/agent-command-reference.md`, explicitly carry the implemented graph-inspection semantics into Pandora's generated command reference, then finish with spec/code and rendered-prompt alignment checks.
- The existing graph-inspection Developer Notes above are preserved as history for completed tasks.
- Added bundled guard includes for `shared/repo-default-branch-guard.md` and `war/cwd-guard.md`, and listed them only on Toil/Greed and War manifest entries respectively.
- Added Spawner coverage that renders every built-in Agent prompt from bundled templates and checks the new guards stay scoped to the agents that reference them.
- Smoke preview found pdx template seeding did not copy nested template directories; fixed recursive materialization/re-seeding so bundled include subdirectories are present in data-dir templates.
- Validation: `pnpm verify` passed.

### Task 7: Markdown command cards — 2026-05-16

- Replaced raw `{{command_cards}}` JSON fences with generated Markdown command references built from the same role-filtered `pithos --help-json` and Pandora pdx `--help-json` paths.
- Leaf commands now render by full command path, description, and shell usage; parent groups remain traversal/filter inputs rather than nested JSON shown to agents.
- Tests cover War, Toil/Greed/Envy, and Pandora Markdown prompt references, absence of raw help JSON markers/fences, and Pandora's continued exclusion of `pdx daemon status` / `pdx daemon logs`.
- Validation: `pnpm verify` passed.

### Task 8: Validated command annotations — 2026-05-16

- Added built-in command annotations keyed by full command path and validated against generated help before prompt rendering.
- Initial notes cover claim, inspect, artifact add, complete, fail, enqueue, supersede, and cancel. They render only when role filtering includes the matching leaf command.
- Tests cover rendered lifecycle annotations and fail-loud behavior when an annotation path disappears from generated help.
- Validation: `pnpm verify` passed.

### Task 9: Pandora graph command guidance — 2026-05-16

- Added Pandora-visible command annotations for `pithos briefing` and `pithos graph inspect`; because non-Pandora role filters do not include those commands, the notes stay Pandora-only at render time.
- Graph guidance now covers selector exclusivity, status/search/since filters, seed-before-closure behavior, readable-vs-JSON usage, and the `repair_source` scope-closure exception.
- Kept the bundled Pandora sitrep flow unchanged because it already orders `pithos briefing --agent pandora` before broad `pithos graph inspect --all` interrogation.
- Validation: `pnpm verify` passed.

### Task 10: Command reference docs convergence — 2026-05-16

- Documented `command_cards` as generated Markdown reference content in template operator and direct-editing docs, including the pre-v1 migration break for extensions that parsed the old raw JSON.
- Clarified that `{{command_reference}}` is not currently a supported template variable.
- Updated Spawner README to describe role filtering, annotation validation, fail-loud help/annotation checks, and the boundary that syntax still comes from `--help-json` while human `--help` remains a separate surface.
- Marked `specs/agent-command-reference.md` implemented and updated the spec index; `specs/control-plane-supervision.md` already matched the implemented filter/render contract.
- YAGNI follow-up removed historical raw-JSON flow and implementation-location planning sections from the implemented command-reference spec, leaving the durable contract only.
- Validation: `pnpm verify` passed.

### Task 11: Command reference spec-code alignment — 2026-05-16

- Added tasks 11–12 at the end of the queue per follow-up request. Task 11 is an explicit spec/code alignment pass for the new command-reference feature; Task 12 is the final generated prompt readability preview.
- Both are AFK because the acceptance criteria are deterministic: compare implementation to specs/docs/tests, preview bundled prompts in an isolated context, and make only small alignment/readability fixes.
- Alignment pass found `specs/agent-command-reference.md`, the Spawner section of `specs/control-plane-supervision.md`, `templates/README.md`, `templates/AGENTS.md`, `packages/spawner/README.md`, and the implementation already agree on `{{command_cards}}` as generated Markdown sourced from `pithos --help-json` / selected `pdx --help-json`.
- Added explicit Spawner regression coverage for configured Pithos command-path disappearance; existing coverage already covered bundled template renderability, Markdown command references, annotations, annotation validation failure, Pandora graph guidance, role-filter exclusions, malformed help JSON, and missing pdx command paths.
