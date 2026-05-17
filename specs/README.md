# Specifications

Persistent domain specifications. Organized by holistic system area, not feature chronology.

## Durable work and control plane

| Spec                                                           | Purpose                                                                                                                                                                     | Code                                                                                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [task-graph.md](./task-graph.md)                               | Defines Pithos' durable Task graph: Tasks, Claims, Dependencies, Source links, Supersessions, Artifacts, Events, inspection, and payload CLI contracts.                     | `packages/pithos/src/`, `packages/pithos/test/`, `packages/pithos/README.md`                                                            |
| [control-plane-supervision.md](./control-plane-supervision.md) | Defines the implemented Control plane across Pithos, Spawner, and pdx: supervision, Registry, Agent lifecycle, Repair Alerts, Nudges, input hooks, and operator interfaces. | `packages/pdx/src/`, `packages/pdx/test/`, `packages/spawner/src/`, `packages/pithos/src/`, `templates/`                                |
| [agent-command-reference.md](./agent-command-reference.md)     | Defines Spawner's generated Markdown command references for Agent prompts, sourced from role-filtered CLI metadata.                                                         | `packages/spawner/src/`, `packages/spawner/src/spawner.test.ts`, `packages/pithos/src/cli.ts`, `packages/pdx/src/main.ts`, `templates/` |
