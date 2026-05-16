# Task 11: Command reference spec-code alignment

## Scope

Type: AFK

Perform the final implementation-facing alignment check for the Agent command-reference feature after code and docs are updated. Compare the implemented Spawner behavior, tests, templates, and docs against the durable specs, then fix any contradictions or mark remaining planned scope accurately.

## Must implement exactly

- Compare implemented behavior against `specs/agent-command-reference.md` and the command-reference section of `specs/control-plane-supervision.md`.
- Verify the code still sources command syntax from `pithos --help-json` and `pdx --help-json`, keeps role filters as documented, and fails loudly for missing command paths, malformed help JSON, and unknown annotation paths.
- Verify `{{command_cards}}` is still the template variable name and now renders generated Markdown command reference content.
- Verify the docs accurately describe the implemented contract, including the pre-v1 migration impact for user extensions that parsed old raw JSON cards.
- Verify tests cover: bundled template renderability, Markdown command references, annotation rendering, annotation validation failure, Pandora graph guidance, and role-filter exclusions.
- If code and docs intentionally differ from the planned spec, update the spec status/content so it tells the truth instead of preserving stale planned behavior.
- Run the relevant Spawner validation commands and docs formatting for touched files.

## Done when

- `specs/agent-command-reference.md`, `specs/control-plane-supervision.md`, `templates/README.md`, `templates/AGENTS.md`, and `packages/spawner/README.md` agree with implemented behavior.
- The command-reference spec status is accurate: Implemented only if the code fully matches it, otherwise Planned or Partial with remaining scope stated clearly.
- No active spec or README claims raw JSON command cards are the intended rendered prompt surface.
- Relevant Spawner tests pass.
- Documentation formatting passes for touched files.

## Out of scope

- New command-reference behavior not already required by tasks 6–10.
- Human `pithos --help` or `pdx --help` redesign.
- Changing Agent roles, Capabilities, or Pithos authorization.
- Broad prompt prose review; final rendered prompt readability is covered by the next task.

## References

- `specs/agent-command-reference.md`
- `specs/control-plane-supervision.md`
- `templates/README.md`
- `templates/AGENTS.md`
- `packages/spawner/README.md`
- `packages/spawner/src/spawner.ts`
- `packages/spawner/src/spawner.test.ts`
