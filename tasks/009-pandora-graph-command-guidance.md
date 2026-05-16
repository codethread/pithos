# Task 9: Pandora graph command guidance

## Scope

Type: AFK

Use the validated annotation layer to teach Pandora the implemented `pithos graph inspect` contract in her generated command reference, with emphasis on the new graph views and their relationship to `pithos briefing`.

## Must implement exactly

- Add Pandora-visible annotations for `pithos briefing` and `pithos graph inspect`.
- The `pithos briefing` annotation must say it owns agenda-style ready/blocked summaries and user-facing next actions.
- The `pithos graph inspect` annotation must summarize the implemented graph-inspection contract:
  - use graph inspect for inventory, dependency shape, provenance, audit, and drill-down task ids;
  - `--task`, `--scope`, and `--all` are mutually exclusive selectors;
  - `--status` is repeatable OR over literal task statuses;
  - `--search` is repeatable AND over task title/body only;
  - `--since` accepts `today`, `<n>h`, `<n>d`, `YYYY-MM-DD`, and ISO timestamps with timezone;
  - filters narrow seed selection before closure, and closure may include related non-matching tasks so blockers, provenance, and supersessions remain understandable;
  - readable output is the normal agent surface, while `--json` is for source edges, exact fields, or scripting;
  - scope graph views intentionally avoid pulling global Repair Alerts into repo/worktree views through reverse `repair_source` closure; inspect a named task or use `--all` when Pandora needs that provenance.
- Keep the existing Pandora prompt sitrep flow aligned with the generated reference. Update only if the prompt contradicts the implemented graph-inspection contract.
- Add tests proving Pandora receives the graph guidance and non-Pandora agents do not receive Pandora-only graph command references.

## Done when

- Rendered Pandora prompt contains concise graph-inspection guidance covering selectors, filters, seed-before-closure behavior, readable vs JSON usage, and the `repair_source` scope-closure exception.
- Rendered Pandora prompt still tells her to use `pithos briefing --agent pandora` before broad graph interrogation for sitrep.
- War, Toil, Greed, and Envy prompts do not include `pithos graph inspect` unless their role filters are intentionally changed by a later spec.
- Relevant Spawner tests pass.

## Out of scope

- Changing Pithos graph inspect behavior.
- Changing `pithos graph inspect --help` wording.
- Adding graph commands to non-Pandora role filters.
- Rewriting Pandora's escalation triage heuristics.

## References

- `specs/agent-command-reference.md`
- `specs/task-graph.md`
- `templates/pandora.md`
- `packages/spawner/src/spawner.ts`
- `packages/spawner/src/spawner.test.ts`
- `packages/pithos/src/cli.ts`
