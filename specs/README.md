# Specifications

Persistent domain specifications. Organized by system area, not feature chronology.

## Pithos task orchestration

| Spec                                                       | Purpose                                                                                                       | Code                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [task-graph.md](./task-graph.md)                           | Define dependency DAGs, supersession history, task inspection handoffs, and graph inspection for Pithos tasks | `packages/pithos/src/`, `packages/pithos/test/`, `packages/pithos/README.md` |
| [pithos-graph-inspection.md](./pithos-graph-inspection.md) | Plan the graph inspect filter/default-rendering contract that supersedes the current `task-graph.md` section  | `packages/pithos/src/`, `packages/pithos/test/`, `packages/pithos/README.md` |

## Agent control plane

| Spec                                                             | Purpose                                                                                                             | Code                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [control-plane-supervision.md](./control-plane-supervision.md)   | Define `pdx` supervision, Pandora escalation, and the boundary between Pithos, spawner, and local lifecycle control | `packages/pithos/src/`, `packages/pithos/test/`, `packages/spawner/src/`, `templates/`, `packages/pdx/` |
| [control-plane-design-notes.md](./control-plane-design-notes.md) | Informal working notes for control-plane API and state-transition discussion                                        | `packages/pithos/src/`, `packages/spawner/src/`, `packages/pdx/`                                        |
| [agent-command-reference.md](./agent-command-reference.md)       | Propose agent-oriented Markdown command references generated from CLI metadata                                      | `packages/spawner/src/`, `templates/`, `packages/pithos/src/cli.ts`, `packages/pdx/src/main.ts`         |
