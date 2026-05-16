# Pithos Graph Inspection

**Status:** Planned
**Last Updated:** 2026-05-16

## 1. Overview

### Purpose

`pithos graph inspect` is the durable task-graph interrogation surface. It shows how selected tasks connect through dependencies, source links, and supersessions. This planned contract supersedes the `pithos graph inspect` interface and visibility behavior currently described in [`task-graph.md`](./task-graph.md); the broader task-graph semantics there remain authoritative. This proposal makes graph inspection truthful by default and adds a small composable filter set for common operator/Pandora questions without turning the command into a general query language.

### Goals

- Make readable graph output show the same selected closed graph as JSON by default.
- Remove implicit terminal-node hiding from default rendering.
- Add minimal seed filters for task status, recent task activity, and task text search.
- Keep filters composable and predictable: different filter kinds combine with AND.
- Preserve graph context by applying filters to seed tasks before closure expansion.
- Keep `briefing` as the agenda/ready/blocked surface instead of duplicating it in graph inspection.

### Non-Goals

- No query language, boolean grouping, relevance ranking, or full-text-search subsystem.
- No aliases such as `active`, `open`, `terminal`, `ready`, `blocked`, or `broken`.
- No `--agent`, `--claimable-by`, `--held-by`, `--created-by`, or capability shortcut filters.
- No graph traversal controls such as direction, depth, or context modes.
- No historical reconstruction of graph state at an earlier time.
- No artifact, event, run transcript, or supervisor-log search.

## 2. Design Decisions

- **Decision:** Default graph inspect output shows all nodes in the selected closed graph.
  - **Rationale:** `inspect` should be truthful and unsurprising. Completed, failed, cancelled, and superseded tasks are often the audit trail needed to answer “what happened?” Noise reduction must be explicit, not hidden in the renderer.

- **Decision:** Remove `--hide-terminal` instead of keeping two visibility modes.
  - **Rationale:** The final surface should have one way to do things. Terminal hiding was a workaround for noisy default output; the new filters provide explicit selection without a second pruning concept.

- **Decision:** Filters apply to seed task selection, then graph closure expands normally.
  - **Rationale:** Filtering after closure can produce orphaned nodes with no blocker/provenance context. Seed-first filtering answers “show matching work, with the graph needed to understand it.”

- **Decision:** Different filter kinds compose with AND.
  - **Rationale:** Operators use filters to narrow the graph: scope plus status plus time plus search should mean tasks satisfying all named constraints before closure expansion.

- **Decision:** Repeated `--status` composes with OR.
  - **Rationale:** A task can have only one status. Requiring all repeated statuses would always produce no seeds, so repeated status values mean “any of these statuses.”

- **Decision:** Repeated `--search` composes with AND.
  - **Rationale:** Search terms narrow recall-driven queries predictably: `--search auth --search token` means tasks whose searchable text contains both terms. OR search can be done by running two commands; adding grouping is out of scope.

- **Decision:** `--since` uses lifecycle task columns only.
  - **Rationale:** The low-cost implementation can answer recent task activity from `tasks.created_at`, `tasks.updated_at`, and `tasks.completed_at`. Artifact/event/run activity belongs to later audit/search surfaces unless a stronger workflow demands it.

- **Decision:** Calendar cutoffs use local operator time.
  - **Rationale:** `today` and `YYYY-MM-DD` are operator-facing convenience forms. Users expect them to mean the current local day, even though stored SQLite timestamps are normalized for comparison.

- **Decision:** `briefing` keeps ready/blocked semantics.
  - **Rationale:** Ready and blocked are agenda concepts. `graph inspect` already exposes `claimable` and `unresolved_dependency_ids` in JSON nodes, but the first-class “anything blocked?” operator view remains `pithos briefing`.

## 3. Architecture

### Component structure

The change stays within Pithos CLI/engine/rendering code:

```text
packages/pithos/src/cli.ts       # graph inspect flags and parsed command input
packages/pithos/src/engine.ts    # seed filtering, graph closure, readable rendering
packages/pithos/test/cli.test.ts # CLI/help/readable-output contract tests
packages/pithos/test/task-lifecycle.test.ts # graph behavior tests
```

### Data flow

```text
graph inspect command
  -> parse exactly one selector: --task, --scope, or --all
  -> parse optional filters: repeated --status, --since, repeated --search
  -> select seed task ids matching selector AND filters
  -> expand dependency/source/supersession closure from those seeds
  -> render full closed graph as readable text, or JSON with --json
```

Closure semantics remain unchanged: dependency, source, and supersession edges are followed so every emitted edge endpoint has a corresponding emitted node.

## 4. Data Model

No schema changes are required.

Seed filtering uses existing task columns:

- `tasks.status`
- `tasks.title`
- `tasks.body`
- `tasks.created_at`
- `tasks.updated_at`
- `tasks.completed_at`
- existing selector columns such as `tasks.id` and `tasks.scope_id`

`--since` selects task rows where any lifecycle timestamp is at or after the parsed cutoff:

```sql
created_at >= :cutoff
OR updated_at >= :cutoff
OR completed_at >= :cutoff
```

`completed_at IS NULL` does not match the completed timestamp branch.

## 5. Interfaces

### CLI contract

```text
pithos graph inspect (--task <task-id> | --scope <scope-id> | --all)
  [--status <queued|claimed|running|done|failed|dead_letter|cancelled>]...
  [--since <cutoff>]
  [--search <text>]...
  [--json]
```

Removed from the graph inspect public surface:

```text
--hide-terminal
```

### Filter semantics

| Filter              | Repeatable | Composition | Seed predicate                                                                                   |
| ------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `--status <status>` | yes        | OR          | `tasks.status` is any provided status                                                            |
| `--since <cutoff>`  | no         | AND         | task `created_at`, `updated_at`, or `completed_at` is at or after cutoff                         |
| `--search <text>`   | yes        | AND         | for every term, task `title` or `body` contains that term using case-insensitive substring match |

All different filter kinds combine with AND.

Selectors still choose the initial domain:

| Selector             | Seed domain before filters |
| -------------------- | -------------------------- |
| `--task <task-id>`   | the named task             |
| `--scope <scope-id>` | tasks in the named scope   |
| `--all`              | all tasks                  |

If filters remove every seed, the command succeeds with an empty graph. Missing named task or scope still fails with the existing tagged `NOT_FOUND` behavior.

### `--since` cutoff formats

Accepted forms:

| Form                        | Meaning                                       |
| --------------------------- | --------------------------------------------- |
| `today`                     | start of the current local day                |
| `<n>h`                      | N hours before the current Pithos clock time  |
| `<n>d`                      | N days before the current Pithos clock time   |
| `YYYY-MM-DD`                | local midnight at the start of that date      |
| ISO timestamp with timezone | exact instant, converted to DB timestamp form |

Invalid cutoffs fail with `VALIDATION_ERROR`; they do not silently behave as no filter.

### Search contract

- Search terms must be non-empty.
- Matching is case-insensitive substring matching over task title and task body only.
- Artifact bodies, artifact titles, event payloads, scope descriptions, paths, and transcript text are not searched.
- Search filters only seed tasks; closure may include related tasks that do not match the search term.

### Examples

```sh
# what did we do today?
pithos graph inspect --all --since today

# where are we up to with auth?
pithos graph inspect --all --search auth

# where are we up to with auth token work?
pithos graph inspect --all --search auth --search token

# currently in flight in frontend codebase?
pithos graph inspect --scope repo:fe --status claimed --status running

# queued frontend work, with graph context
pithos graph inspect --scope repo:fe --status queued
```

For agenda questions such as “anything still blocked?”, use:

```sh
pithos briefing
```

## 6. Implementation Phases

### Phase 1: Default rendering cleanup

- [ ] Remove implicit terminal-node hiding from `renderGraphInspectText`.
- [ ] Remove `--hide-terminal` from CLI parsing and generated help.
- [ ] Remove engine input plumbing and `filterTerminalLeaves` behavior tied to `--hide-terminal`.
- [ ] Update readable graph snapshots so text and JSON select the same graph by default.

### Phase 2: Seed filters

- [ ] Add parsed graph filter input for repeated `--status`, optional `--since`, and repeated `--search`.
- [ ] Validate status values through the existing task status schema/literal set.
- [ ] Parse `--since` cutoff forms with tagged validation failures.
- [ ] Apply selector and filters to seed queries before calling graph closure.
- [ ] Preserve closure guarantees for dependencies, source links, and supersessions.

### Phase 3: Tests and docs

- [ ] Test repeated `--status` OR semantics.
- [ ] Test repeated `--search` AND semantics.
- [ ] Test `--since today`, relative durations, ISO date, and invalid cutoff failures.
- [ ] Test filter-before-closure behavior: matching seeds include non-matching blockers/provenance neighbors.
- [ ] Update `packages/pithos/README.md` only if its help-surface guidance needs a graph inspect note.
- [ ] Run `pnpm verify` after implementation.

## 7. Code Locations

| File                                          | Change                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/pithos/src/cli.ts`                  | Modify graph inspect options and help surface                                            |
| `packages/pithos/src/engine.ts`               | Modify graph inspect input, seed filtering, and text render                              |
| `packages/pithos/test/cli.test.ts`            | Update help/snapshot/CLI behavior tests                                                  |
| `packages/pithos/test/task-lifecycle.test.ts` | Add graph filtering and closure behavior tests                                           |
| `packages/pithos/README.md`                   | Update only if generated-help guidance becomes insufficient                              |
| `specs/task-graph.md`                         | Fold this planned graph-inspect contract into the implemented task-graph spec once built |

## 8. Open Questions

None for the MVP proposal.
