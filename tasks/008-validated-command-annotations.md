# Task 8: Validated command annotations

## Scope

Type: AFK

Add a small command annotation layer on top of generated Markdown command cards so stable agent-facing notes can be attached to specific command paths without duplicating command syntax in templates.

## Must implement exactly

- Define a typed command-annotation map keyed by full command path.
- Validate every annotation key against the parsed generated help tree before rendering; unknown annotation paths must fail loudly as template/render errors.
- Render annotation notes beneath the matching command in the Markdown command reference.
- Keep annotations compact and operational. They should clarify usage, not restate whole specs or replace `_common.md` recipes.
- Add initial annotations for core lifecycle commands where they improve reliability:
  - rendered claim command / `pithos task claim` note that agents should use the generated claim command above;
  - `pithos task inspect` note that readable Markdown is the normal context and `--json` is for exact fields or token recovery;
  - `pithos task artifact add` note to use `--stdin` with a quoted heredoc for body content;
  - `pithos task complete` note that default completion uses no stdin and `--stdin` is only JSON object metadata;
  - `pithos task fail` note that failure should include a concise reason and relevant evidence;
  - `pithos task enqueue` note that ordinary follow-up omits `--chain`, while intentionally unrelated work uses `--chain none`;
  - `pithos task supersede` and `pithos task cancel` notes that they are graph-repair/abandonment tools, not normal completion tools.
- Add tests covering rendered annotations and a failing unknown annotation path.

## Done when

- Generated command references include concise notes for annotated command paths.
- Invalid annotation keys fail loudly during render.
- Existing role filtering still controls whether an annotation can appear for an Agent kind.
- Relevant Spawner tests pass.

## Out of scope

- Pandora-specific graph-inspection guidance; that is a separate follow-up task.
- Moving workflow policy out of `_common.md` or role templates.
- Adding user-configurable annotation files.
- Renaming `{{command_cards}}`.

## References

- `specs/agent-command-reference.md`
- `templates/_common.md`
- `templates/pandora.md`
- `packages/spawner/src/spawner.ts`
- `packages/spawner/src/spawner.test.ts`
