# Task 1: Truthful graph rendering

## Scope

Type: AFK

Change `pithos graph inspect` so the default readable graph renders every node in the selected closed graph, matching the default JSON selection. Remove the old `--hide-terminal` command surface and the terminal-leaf pruning behavior tied to it.

## Must implement exactly

- Remove implicit terminal-node hiding from the readable graph renderer.
- Remove `--hide-terminal` from graph inspect CLI parsing, generated help, engine input, and any graph filtering code path.
- Keep selector behavior unchanged: exactly one of `--task`, `--scope`, or `--all` is required.
- Keep graph closure behavior unchanged for dependency, source, and supersession edges.
- Update tests/snapshots that expected hidden terminal nodes or the old `--hide-terminal` flag.
- Preserve tagged fail-loud behavior for invalid graph selectors.

## Done when

- `pithos graph inspect --task <id>` readable output includes terminal nodes that are present in the selected closed graph.
- Default readable output and `--json` output are based on the same unpruned graph selection.
- `pithos graph inspect --hide-terminal` is no longer accepted and no longer appears in generated help.
- Relevant Pithos CLI and graph tests pass.

## Out of scope

- Adding new graph filters.
- Changing graph closure semantics.
- Changing briefing behavior.
- Adding aliases or replacement flags for terminal hiding.

## References

- `specs/pithos-graph-inspection.md`
- `specs/task-graph.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
