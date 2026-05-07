# Specifications

Persistent domain specifications. Organized by system area, not feature chronology.

## Pithos task orchestration

| Spec | Purpose | Code |
| ---- | ------- | ---- |
| [task-graph.md](./task-graph.md) | Define dependency DAGs, supersession history, and graph inspection for Pithos tasks | `packages/cli/src/db/`, `packages/cli/src/domain/task-graph.ts`, `packages/cli/src/commands/`, `packages/cli/src/cli/commands.ts`, `packages/cli/test/`, `packages/cli/README.md` |

## Agent control plane

| Spec | Purpose | Code |
| ---- | ------- | ---- |
| [control-plane-supervision.md](./control-plane-supervision.md) | Define `pdx` supervision, Pandora escalation, and the boundary between Pithos, spawner, and local lifecycle control | `packages/cli/src/`, `packages/spawner/src/`, `packages/spawner/templates/`, `packages/pdx/` |
| [control-plane-design-notes.md](./control-plane-design-notes.md) | Informal working notes for control-plane API and state-transition discussion | `packages/cli/src/`, `packages/spawner/src/`, `packages/pdx/` |
