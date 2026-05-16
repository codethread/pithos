# Task 7: Markdown command cards

## Scope

Type: AFK

Replace the raw JSON injected by `{{command_cards}}` with concise Markdown generated from the existing parsed CLI help trees. Keep the current role filters and fail-loud command-path validation.

## Must implement exactly

- Render `{{command_cards}}` as Markdown, not raw JSON fences.
- Continue sourcing command syntax from `pithos --help-json` and `pdx --help-json`.
- Preserve the existing role-filtered command sets:
  - War: `pithos task`;
  - Toil, Greed, Envy: `pithos scope` and `pithos task`;
  - Pandora: `pithos scope`, `pithos task`, `pithos graph`, `pithos events`, `pithos briefing`, plus `pdx run transcript`, `pdx run show`, and `pdx task show`.
- Keep missing configured command paths and malformed help JSON as render-time `TEMPLATE_ERROR` failures.
- Render leaf commands by full path with description and usage. Parent command groups may be section headings, but must not bury leaf command syntax in nested JSON.
- Keep the rendered claim command as the canonical exact claim invocation for the run.
- Update prompt-render tests so they assert Markdown command reference behavior rather than JSON tree structure.

## Done when

- War, Toil/Greed/Envy, and Pandora rendered prompts contain Markdown command-reference sections with the expected command paths.
- Rendered prompts no longer contain `### Pithos help JSON`, `### pdx inspection help JSON`, or fenced raw help JSON blocks.
- Tests still prove Pandora excludes `pdx daemon status` and `pdx daemon logs` from generated command references.
- Relevant Spawner tests pass.

## Out of scope

- Adding command annotations or examples beyond the basic generated description/usage rendering.
- Changing human `pithos --help` or `pdx --help` output.
- Changing `--help-json` schema.
- Changing template variable names.

## References

- `specs/agent-command-reference.md`
- `specs/control-plane-supervision.md`
- `packages/spawner/src/spawner.ts`
- `packages/spawner/src/spawner.test.ts`
- `packages/pithos/src/cli.ts`
- `packages/pdx/src/main.ts`
