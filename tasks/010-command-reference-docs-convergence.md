# Task 10: Command reference docs convergence

## Scope

Type: AFK

After Markdown command cards and annotations are implemented, make the durable docs describe the actual template/rendering contract and migration impact.

## Must implement exactly

- Update `templates/README.md` so `command_cards` is documented as generated Markdown command reference content, not raw JSON.
- Update `templates/AGENTS.md` with the same variable contract and clear guidance that `{{command_reference}}` is not a supported variable unless it is actually added.
- Document the pre-v1 migration impact: user extension templates that parsed old raw JSON from `{{command_cards}}` must treat it as prose/reference content or replace the template wholesale.
- Update `packages/spawner/README.md` to describe command-reference rendering, role filtering, annotation validation, and the boundary that Spawner still sources syntax from `--help-json`.
- Update `specs/agent-command-reference.md` from Planned to Implemented only if the code now matches the spec; otherwise leave status accurate and explain remaining planned scope.
- Keep `specs/control-plane-supervision.md` aligned if any implemented role filters or rendered command-reference behavior differ from the current spec text.
- Run formatting on touched docs.

## Done when

- No active README/spec says generated prompt command cards are raw JSON.
- The template variable list still names `command_cards` exactly.
- The docs explain that human `--help` and agent command references are separate surfaces that share structured CLI metadata.
- The spec index remains accurate.
- Documentation formatting passes for touched files.

## Out of scope

- Code changes to Spawner rendering.
- Human `pithos --help` or `pdx --help` redesign.
- Adding a new `command_reference` template variable.
- Changing Agent roles or command filters.

## References

- `specs/agent-command-reference.md`
- `specs/control-plane-supervision.md`
- `specs/README.md`
- `templates/README.md`
- `templates/AGENTS.md`
- `packages/spawner/README.md`
