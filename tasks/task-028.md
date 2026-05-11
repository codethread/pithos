# Task 028: Auto-chain docs and prompts

## Scope

Type: AFK

Update agent-facing prompts, command docs, and package docs after automatic chaining and source links are implemented so agents stop manually wiring routine held-task dependencies.

The prompt surface should stay intentionally small: ordinary follow-up omits `--chain`, unrelated work uses `--chain none`, and Pandora's escalation-resolution handoffs rely on default auto from the held escalation source.

## Must implement exactly

- Update `packages/spawner/templates/_common.md` to explain task graph vs task chain only as operational guidance, not as a graph-theory lesson.
- Replace routine `--depends-on <held-task-id>` recipes with default-auto enqueue recipes for ordinary follow-up work.
- Preserve guidance that manual `--depends-on` is for extra prerequisites/fan-in and combines with default auto.
- Document `--chain none --depends-on <task-id>` as the manual-only form.
- Update Pandora's template with the explicit Q convention:
  - unrelated “Q this” while holding an escalation uses `--chain none`
  - resolving the held escalation's source uses default auto
  - “Q this for task_X” uses `--chain none --depends-on task_X`
- Keep `--chain held` and `--chain source` out of routine agent recipes except as advanced/fail-loud modes in CLI/package docs.
- Update Pithos README/help-facing docs for `--chain`, source links, dependency vs source semantics, and enqueue output metadata.
- Update any prompt/template tests or snapshots so rendered prompts no longer contradict the implemented chaining behavior.
- Add a Developer Note summarizing the prompt contract if any follow-up ambiguity remains.

## Done when

- Rendered agent prompts no longer tell ordinary agents to manually pass `--depends-on <held-task-id>` for routine follow-up work.
- Pandora prompt clearly distinguishes unrelated Qs from escalation-resolution handoffs.
- Pithos docs describe source links as non-blocking provenance and dependencies as claimability gates.
- Relevant spawner and pithos docs/tests pass.

## Out of scope

- Engine, DB, or CLI behavior changes.
- Rewriting unrelated role descriptions.
- Introducing arbitrary `relates_to` relationships.
- Changing generated command-card infrastructure beyond content needed for the new flag/docs.

## References

- `specs/task-graph.md`
- `UBIQUITOUS_LANGUAGE.md`
- `packages/spawner/templates/_common.md`
- `packages/spawner/templates/pandora.md.tmpl`
- `packages/spawner/templates/toil.md.tmpl`
- `packages/spawner/templates/greed.md.tmpl`
- `packages/spawner/templates/war.md.tmpl`
- `packages/spawner/src/spawner.test.ts`
- `packages/pithos/README.md`
- `packages/pithos/test/cli.test.ts`
