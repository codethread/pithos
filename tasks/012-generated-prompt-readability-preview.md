# Task 12: Generated prompt readability preview

## Scope

Type: AFK

Preview the final generated prompts for every built-in Agent kind and make sure the rendered command references read well in the context of each role's prompt and the overall Pandora's Box operating intentions.

## Must implement exactly

- Use isolated preview context; do not point preview runs at a real user database or live supervisor state.
- Render or preview prompts for Pandora, Toil, Greed, War, and Envy with bundled templates.
- Inspect the rendered prompts as whole prompts, not just snippets, for these readability criteria:
  - the role, required flow, common recipes, and generated command reference reinforce each other instead of contradicting;
  - `{{command_cards}}` content is concise Markdown, not raw JSON;
  - command syntax is discoverable without asking agents to parse human `--help` output;
  - command references do not overwhelm or obscure role-specific instructions;
  - Pandora's prompt clearly distinguishes `pithos briefing --agent pandora` for agenda/ready-blocked summaries from `pithos graph inspect` for inventory, provenance, dependency shape, and drill-down ids;
  - Pandora's graph guidance covers the implemented filters and the `repair_source` scope-graph exception without sounding like a general graph tutorial;
  - War, Toil, Greed, and Envy do not receive Pandora-only graph/pdx inspection guidance;
  - guard includes read as safety guidance, not vague warnings or silent fallbacks.
- Fix small wording, annotation, or docs inconsistencies found during preview. If a larger design issue appears, leave the smallest truthful note in `tasks/README.md` Developer Notes and do not invent a new feature.
- Capture the preview commands run and a concise verdict in `tasks/README.md` Developer Notes.

## Done when

- Bundled prompt preview succeeds for all five built-in Agent kinds.
- The generated prompts are readable enough for AFK/HITL agents to use the command reference without parsing human help output.
- The final Pandora prompt surfaces the new graph views in a way consistent with `specs/task-graph.md`, `templates/pandora.md`, and `README.md`'s operator-facing system intent.
- Any readability fixes are committed to templates, annotations, renderer output, or docs as appropriate.
- Relevant Spawner tests or preview checks pass after any fixes.

## Out of scope

- Launching real Harness sessions.
- Starting `pdx open` or touching live tmux supervisor state.
- Adding new command filters, annotations, or prompt sections beyond fixes needed for readability/alignment.
- Rewriting role identities or task-graph policy.

## References

- `specs/agent-command-reference.md`
- `specs/task-graph.md`
- `README.md`
- `templates/pandora.md`
- `templates/toil.md`
- `templates/greed.md`
- `templates/war.md`
- `templates/envy.md`
- `packages/spawner/README.md`
- `packages/spawner/src/spawner.ts`
- `packages/spawner/src/spawner.test.ts`
