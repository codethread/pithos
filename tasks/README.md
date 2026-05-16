# Graph inspect AFK task plan

## Problem statement / MVP goal

Implement the planned `pithos graph inspect` contract in `specs/pithos-graph-inspection.md` as a small, deterministic MVP: graph text output is truthful by default, `--hide-terminal` is removed, and seed filters support literal task statuses, repeated AND search terms, and recent task activity via `--since`.

## Important references

- `specs/pithos-graph-inspection.md` — planned graph inspect filter/default-rendering contract for this task plan.
- `specs/task-graph.md` — implemented task graph semantics; the new spec supersedes only the graph inspect interface/visibility portion.
- `packages/pithos/src/cli.ts` — CLI command parsing and generated help surface.
- `packages/pithos/src/engine.ts` — graph seed selection, closure expansion, node metadata, and readable renderer.
- `packages/pithos/test/cli.test.ts` — CLI output/help/snapshot contracts.
- `packages/pithos/test/task-lifecycle.test.ts` — task graph behavior and rendering coverage.
- Existing `tasks/task-*` files are historical archive material and are not part of this active AFK queue; `tasks/index.yml` is the queue for this plan.

## Task strategy

The slices are intentionally linear because each task touches the same `graph inspect` command path and should leave the CLI in a coherent state for the next AFK run.

1. First make graph rendering truthful and remove the old terminal-hiding surface. This establishes the new baseline and removes the main surprising behavior.
2. Add status filtering as the smallest seed-filter path through CLI parsing, engine selection, graph closure, and tests.
3. Add search filtering using the same seed-filter path, with repeated terms narrowing via AND.
4. Add time filtering with `--since`, including fail-loud cutoff parsing and deterministic tests.
5. Fold the implemented behavior back into durable docs so the planned spec, implemented task graph spec, and generated help guidance do not contradict each other.

No HITL slices are required. The product decisions are already captured in `specs/pithos-graph-inspection.md`; each implementation task has deterministic acceptance criteria and local validation.

## Developer Notes

Append notes here. Do not rewrite earlier notes.

### Task 1: Truthful graph rendering — 2026-05-16

- This plan replaces `tasks/index.yml` with the active AFK queue requested for graph inspection work. Older `tasks/task-*` files remain in the repository as historical archive files but are intentionally unreferenced by this queue.
