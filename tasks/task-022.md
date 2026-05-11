# Task 022: Inject role-filtered command help into agent prompts

## Scope

Type: AFK

Replace stale hand-written command recipes in Spawner templates with generated, role-filtered command help cards for Pithos and, for Pandora, pdx.

Agent prompts should receive only the commands they need for their role. The command cards should be generated from the machine-readable help surfaces added for Pithos and pdx so prompt instructions stay aligned with CLI behavior.

## Must implement exactly

- Update Spawner prompt rendering so templates can include generated command help cards.
- Use the Pithos JSON help tree as the source for role-specific Pithos command cards.
- Use the pdx JSON help tree or shared pdx help renderer as the source for Pandora's pdx inspection command cards.
- Preserve existing run/session/scope/cwd context injection and the rendered claim command.
- War must receive command cards for claiming execute work, inspecting tasks, adding artifacts, completing/failing held work, and escalating when needed.
- Toil must receive command cards for claiming triage work, inspecting tasks, enqueuing follow-up work, artifacts, complete/fail, and non-held graph repair commands when appropriate.
- Pandora must receive broader Pithos cards for escalation work, briefing, graph/events inspection, enqueueing follow-up work, plus pdx cards for daemon status/logs and run transcripts.
- Keep role filters explicit and deterministic; fail loudly if a requested command path is missing from the generated help tree.
- Remove duplicated/static command recipe prose from templates where generated cards now own the contract.
- Add or update tests that render at least War and Pandora prompts and assert expected command cards appear.

## Done when

- Rendered War prompt includes generated Pithos command cards and no stale contradictory command recipe prose.
- Rendered Pandora prompt includes generated Pithos command cards and pdx inspection cards.
- Missing command paths in the filter configuration fail tests/rendering loudly instead of silently omitting docs.
- Relevant spawner tests pass.

## Out of scope

- Changing task/run lifecycle semantics.
- Changing pdx default human help.
- Rich structured option/argument docs beyond the generated command usage and description.
- Removing the `pandora-spawn preview` CLI.

## References

- `packages/spawner/src/spawner.ts`
- `packages/spawner/templates/_common.md`
- `packages/spawner/templates/war.md.tmpl`
- `packages/spawner/templates/toil.md.tmpl`
- `packages/spawner/templates/greed.md.tmpl`
- `packages/spawner/templates/pandora.md.tmpl`
- `packages/spawner/src/spawner.test.ts`
- `packages/pithos/src/cli.ts`
- `packages/pdx/src/main.ts`
- `specs/control-plane-supervision.md`
- `UBIQUITOUS_LANGUAGE.md`
