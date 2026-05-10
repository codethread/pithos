# Task Graph

**Status:** Implemented
**Last Updated:** 2026-05-07

## 1. Overview

### Purpose

Pithos tasks use a first-class dependency DAG plus a linear supersession history. This lets agents create cross-scope blocked work, claim only ready tasks, replace a wrong middle task with a new one without mutating task contents, and inspect the current graph in machine-readable form.

### Goals

- Allow any task to depend on zero or more existing tasks.
- Allow dependency edges to span scopes freely.
- Make `pithos task claim` return only queued tasks whose dependencies are all `done`.
- Preserve history when one task replaces another.
- Let agents inspect blockers, dependents, and the current connected graph without reconstructing it from prose.
- Surface ready versus blocked work in `pithos briefing`.

### Non-Goals

- A generic mutable graph editor for arbitrary post-creation rewiring.
- In-place mutation of task `title`, `body`, or `capability` to preserve history.
- Priority scheduling, critical-path scheduling, or any optimizer beyond FIFO among claimable tasks.
- Performance work for large graphs or remote databases; correctness and clarity win.
- Automatic downstream repair once work has already started from superseded input.

## 2. Design Decisions

- **Decision:** Model blocking with a dedicated `task_dependencies` join table.
  - **Rationale:** Blocking is many-to-many, must support cross-scope edges, and must be queryable from SQLite for atomic claim decisions.

- **Decision:** Keep dependency edges current-state only, and preserve graph history through `task_supersessions` plus `events` rows.
  - **Rationale:** Agents need fast answers to “what blocks this now?” while still being able to explain “what replaced what?”. Current-state tables keep claim and inspect simple; events preserve provenance.

- **Decision:** Keep tasks effectively immutable; replacing a wrong task creates a new task and links it with a supersession edge.
  - **Rationale:** Mutating `body` in place would make prior claims, artifacts, and event history ambiguous. A new task preserves the full instruction snapshot seen by each worker.

- **Decision:** Make supersession linear and separate from dependencies.
  - **Rationale:** Dependency structure needs DAG fan-in/fan-out; replacement history is the user’s “linked list” concept. Mixing the two would make both claim semantics and history harder to reason about.

- **Decision:** Compute blocked versus ready dynamically instead of adding a persisted `blocked` task status.
  - **Rationale:** A queued task can become ready when a dependency completes. Deriving readiness from current dependency state avoids status drift and keeps the database as the source of truth.

- **Decision:** `claim` remains FIFO, but only among claimable tasks.
  - **Rationale:** Older blocked work must not starve newer ready work. The user asked to “always surface the next available tasks”; claimability is therefore part of the ordering filter, not just presentation.

- **Decision:** `supersede` rewires only direct queued dependents, ignores cancelled dependents, and rejects replacement when any other direct dependent has already left `queued`.
  - **Rationale:** Once downstream work has started, automatic rewrites become ambiguous and can hide invalid work. Cancelled dependents are already terminal and need no retarget. Fail loudly and require an explicit follow-up plan instead.

- **Decision:** Support cross-scope dependency edges without special casing the claim path.
  - **Rationale:** The user’s primary use case is FE/BE/design/spec work spanning repos. Claim already filters by the task being claimed; blocker lookup can naturally join across scopes.

- **Decision:** The schema is a clean break. Fresh databases get the DAG and supersession tables directly, with no legacy parent-model compatibility path.

## 3. Architecture

### Component structure

```text
packages/pithos/src/
  cli/commands.ts           # wire new flags and subcommands
  commands/
    enqueue.ts              # repeated --depends-on support
    claim.ts                # claimable-task selection
    inspect.ts              # relationship-aware task inspection + graph subcommand
    briefing.ts             # ready vs blocked rendering
    supersede.ts            # new command: replace a task with a new one
  db/
    migrate.ts              # initial schema with dependency + supersession tables
    rows.ts                 # TaskDependencyRow / TaskSupersessionRow
  domain/
    task-graph.ts           # shared graph queries, cycle checks, claimability helpers
```

Tests live beside commands and in `packages/pithos/test/` for end-to-end SQLite coverage.

### Data flow

```text
enqueue/supersede
  -> validate referenced runs/scopes/tasks
  -> transaction writes tasks + relationship rows + events
  -> commit only if resulting dependency graph is acyclic

claim
  -> transaction selects oldest queued task in requested scope/capability
  -> filter out tasks with unresolved dependencies across any scope
  -> claim task + emit event

inspect/briefing
  -> query current tasks + task_dependencies + task_supersessions
  -> compute claimability and unresolved blockers at read time
  -> print structured JSON or markdown
```

### Schema deployment

The initial schema (migration 1) creates all tables — `tasks`, `task_dependencies`, `task_supersessions`, etc. — in a single atomic migration. There is no separate migration 2. The `tasks` table does not include `parent_id`; the DAG tables are the sole relationship model from the start.

## 4. Data Model

### Database schema

The initial schema includes the following tables and indexes:

```sql
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id            TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_task
  ON task_dependencies(task_id);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocker
  ON task_dependencies(depends_on_task_id);

CREATE TABLE IF NOT EXISTS task_supersessions (
  old_task_id       TEXT PRIMARY KEY REFERENCES tasks(id),
  new_task_id       TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  created_by_run_id TEXT REFERENCES runs(id),
  reason            TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (old_task_id <> new_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_supersessions_new
  ON task_supersessions(new_task_id);
```

### Readiness contract

A task is claimable when all of the following are true:

- `tasks.status = 'queued'`
- there is no `task_dependencies` row for that task whose `depends_on_task_id` points to a task with `status <> 'done'`
- the task has not itself been superseded into a replacement that should be claimed instead

The last rule is enforced operationally by `supersede`: if the old task is still `queued`, it is moved to `cancelled` in the same transaction that creates the replacement.

### Core graph types

```ts
type GraphEdge =
	| { kind: "depends_on"; from_task_id: string; to_task_id: string; satisfied: boolean }
	| { kind: "supersedes"; from_task_id: string; to_task_id: string };

type GraphNode = {
	id: string;
	scope_id: string;
	capability: string;
	status: string;
	title: string;
	claimable: boolean;
	unresolved_dependency_ids: readonly string[];
	supersedes_task_id: string | null;
	superseded_by_task_id: string | null;
};
```

These are response-contract types, not a directive to mirror them 1:1 in source.

## 5. Interfaces

### CLI commands

> Note: `control-plane-supervision.md` supersedes the command paths, capability vocabulary, and authorization requirements below. The graph semantics in this spec remain normative, but the post-rewrite public surface uses nested commands such as `pithos task enqueue`, `pithos task claim`, `pithos task inspect`, and `pithos graph inspect`, with capabilities limited to `triage`, `design`, `execute`, and `escalate`.

| Command                           | Change           | Contract                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pithos task enqueue`             | Modify           | Support repeatable `--depends-on <task-id>`. All referenced tasks must exist. Duplicate IDs fail validation. Requires a resolved run, non-empty body, known capability, and `agent_enqueues` authorization.                              |
| `pithos task claim`               | Modify semantics | Claim the oldest queued task matching `--scope` and `--capability` whose dependencies are all `done`. Exit code stays `5` for “no claimable work”. Requires `agent_claims` authorization, matching run scope, and no existing held task. |
| `pithos task inspect <id>`        | Expand output    | Return the task, artifacts, direct dependencies, direct dependents, unresolved blockers, and immediate supersession links.                                                                                                               |
| `pithos graph inspect`            | New              | Return graph JSON for one selector: `--task <id>`, `--scope <scope-id>`, or `--all` (deprecated alias: `--current`).                                                                                                                     |
| `pithos task supersede <task-id>` | New              | Create a replacement task, copy the old task’s upstream dependencies, retarget direct queued dependents, record supersession history, and cancel the old task if it was still queued.                                                    |
| `pithos briefing`                 | Modify output    | Split queued work into ready and blocked, and list blocking task IDs/scopes/statuses for blocked items.                                                                                                                                  |
| `pithos tail`                     | New event types  | Surface `task.superseded` and `task.cancelled` events introduced by replacement flows.                                                                                                                                                   |

### `pithos task enqueue`

New flag surface:

| Flag                                   | Description                                                    | Default                       |
| -------------------------------------- | -------------------------------------------------------------- | ----------------------------- | ---------- | ------------------------------ | -------- |
| `--scope <scope-id>`                   | Scope for the new task                                         | required                      |
| `--capability <triage                  | design                                                         | execute                       | escalate>` | Capability for matching agents | required |
| `--title <title>`                      | Human-readable title for the task                              | required                      |
| `--body <text>` / `--body-file <path>` | Task body                                                      | required                      |
| `--run <run-id>`                       | Creating run; defaults from `PITHOS_RUN_ID` for spawned agents | required after env resolution |
| `--depends-on <task-id>`               | Dependency edge to an existing task; repeatable                | none                          |

Behavioral rules:

- all dependency targets must already exist
- dependency targets may be in any scope
- if a dependency target has already been superseded, `enqueue` must fail with a tagged user-facing error that points at the replacement task; the command must not silently rewrite to a different task ID
- duplicate dependency IDs are rejected with `VALIDATION_ERROR`
- the creating run must exist and its agent kind must be authorized in `agent_enqueues` for the requested capability
- manual/operator enqueue without a resolved run is not exposed
- body must be non-empty; capability-specific scope/body rules from `control-plane-supervision.md` apply
- the transaction must fail if the resulting graph would contain a cycle
- `task.created` event payload must include `depends_on_task_ids`

### `pithos supersede <task-id>`

Required/optional surface:

| Flag / arg                             | Description                                    | Default             |
| -------------------------------------- | ---------------------------------------------- | ------------------- |
| `<task-id>`                            | Task being replaced                            | required            |
| `--run <run-id>`                       | Actor performing the replacement               | required            |
| `--title <title>`                      | Replacement task title                         | old task title      |
| `--body <text>` / `--body-file <path>` | Replacement task body                          | old task body       |
| `--scope <scope-id>`                   | Replacement task scope                         | old task scope      |
| `--capability <cap>`                   | Replacement task capability                    | old task capability |
| `--reason <text>`                      | Human-readable reason stored with supersession | required            |

Transaction contract:

1. Validate old task exists.
2. Validate actor run exists.
3. Reject if old task status is `claimed` or `running`.
4. Reject if the old task already has a `task_supersessions` row; a task may be superseded at most once.
5. Load direct dependents of the old task.
6. Reject if any direct dependent has status other than `queued` or `cancelled`. Cancelled dependents are ignored rather than retargeted.
7. Create the new task with this exact contract:
   - copy from old task: `scope_id`, `capability`, `title`, `body`, `payload_json`, `max_attempts`
   - apply explicit CLI overrides on `scope_id`, `capability`, `title`, and body
   - reset operational fields to fresh-task values: `status='queued'`, `fencing_token=0`, `attempts=0`, `result_json='{}'`, `completed_at=NULL`, fresh `created_at`/`updated_at`
   - set `created_by_run_id` to the actor run
8. Copy all direct upstream dependency edges from old task to new task.
9. Retarget each direct queued dependent from `depends_on old` to `depends_on new`.
10. Insert one `task_supersessions` row.
11. If old task was `queued`, set it to `cancelled` and emit `task.cancelled` with the same non-empty supersession reason plus `superseded_by_task_id`.
12. Emit `task.created` for the new task and `task.superseded` for the old task.
13. Validate the resulting dependency graph is acyclic before commit.

The command returns JSON:

```json
{
	"ok": true,
	"task": { "id": "task_d", "status": "queued", "scope_id": "repo:be", "capability": "execute" },
	"supersession": {
		"old_task_id": "task_b",
		"new_task_id": "task_d",
		"retargeted_dependent_task_ids": ["task_c"]
	}
}
```

### `pithos task inspect <id>`

Success response shape:

```json
{
	"ok": true,
	"task": {
		"id": "task_c",
		"scope_id": "repo:fe",
		"capability": "execute",
		"status": "queued",
		"claimable": false,
		"unresolved_dependency_ids": ["task_d"]
	},
	"dependencies": [
		{ "id": "task_d", "scope_id": "repo:be", "status": "queued", "title": "Fix API" }
	],
	"dependents": [],
	"supersedes": null,
	"superseded_by": null,
	"artifacts": []
}
```

Requirements:

- relationship arrays must be deterministic and sorted by `created_at`, then `id`
- dependency/dependent summaries must always include `scope_id`
- `claimable` and `unresolved_dependency_ids` are computed, never stored

### `pithos graph inspect`

Selectors are mutually exclusive:

| Selector             | Result                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--task <id>`        | Transitive closure around that task following dependency and supersession edges both directions                                                                                  |
| `--scope <scope-id>` | Seed with all non-cancelled tasks in that scope, then walk dependency and supersession edges in both directions recursively until the response is closed                         |
| `--all`              | All non-cancelled tasks and all current graph edges, plus any referenced dependency or supersession neighbors needed to keep the response closed (deprecated alias: `--current`) |

Output flags:

| Flag     | Effect                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------- |
| `--flat` | Render a plain-text supersession-chain tree (opt-in text mode; hides completed chains by default) |
| `--dump` | Show all chains including completed ones; only meaningful with `--flat`, no-op in JSON mode       |

#### `--flat` filtering behavior

When `--flat` is used without `--dump`, the output is filtered to show only active work:

- **Fully-terminal chains** are hidden: a supersession chain where every node has status `done` or `cancelled` is removed from the flat output entirely.
- **Standalone terminal nodes** are hidden: nodes with no supersession links and status `done` or `cancelled` are removed.
- Chains with at least one active node (status other than `done`/`cancelled`) are shown in full — including their cancelled predecessors — so the user can see the full history of an active chain.
- `--dump` overrides this and shows everything.
- Filtering does not affect JSON output (only applies to `--flat` text-tree mode).

Graph closure requirement:

- every `from_task_id`, `to_task_id`, `supersedes_task_id`, and `superseded_by_task_id` emitted in the response must refer to a node present in `graph.nodes`
- this may require including cancelled supersession neighbors when they are referenced by returned supersession edges or node fields

Success response shape:

```json
{
	"ok": true,
	"graph": {
		"selector": { "kind": "task", "value": "task_c" },
		"nodes": [
			{
				"id": "task_a",
				"scope_id": "repo:design",
				"capability": "design",
				"status": "done",
				"title": "Finalize API sketch",
				"claimable": false,
				"unresolved_dependency_ids": [],
				"supersedes_task_id": null,
				"superseded_by_task_id": null
			},
			{
				"id": "task_b",
				"scope_id": "repo:be",
				"capability": "execute",
				"status": "cancelled",
				"title": "Original API task",
				"claimable": false,
				"unresolved_dependency_ids": [],
				"supersedes_task_id": null,
				"superseded_by_task_id": "task_d"
			},
			{
				"id": "task_d",
				"scope_id": "repo:be",
				"capability": "execute",
				"status": "queued",
				"title": "Fix API",
				"claimable": true,
				"unresolved_dependency_ids": [],
				"supersedes_task_id": "task_b",
				"superseded_by_task_id": null
			},
			{
				"id": "task_c",
				"scope_id": "repo:fe",
				"capability": "execute",
				"status": "queued",
				"title": "Update FE client",
				"claimable": false,
				"unresolved_dependency_ids": ["task_d"],
				"supersedes_task_id": null,
				"superseded_by_task_id": null
			}
		],
		"edges": [
			{ "kind": "depends_on", "from_task_id": "task_d", "to_task_id": "task_a", "satisfied": true },
			{
				"kind": "depends_on",
				"from_task_id": "task_c",
				"to_task_id": "task_d",
				"satisfied": false
			},
			{ "kind": "supersedes", "from_task_id": "task_d", "to_task_id": "task_b" }
		]
	}
}
```

Graph ordering requirements:

- `nodes` are sorted by task `created_at`, then task `id`
- `edges` are sorted by `kind`, then `from_task_id`, then `to_task_id`

### Claim query contract

The claim-selection subquery becomes:

```sql
SELECT t.id
FROM tasks t
WHERE t.status = 'queued'
  AND t.scope_id = ?
  AND t.capability = ?
  AND NOT EXISTS (
    SELECT 1
    FROM task_dependencies td
    JOIN tasks dep ON dep.id = td.depends_on_task_id
    WHERE td.task_id = t.id
      AND dep.status <> 'done'
  )
ORDER BY t.created_at ASC, t.id ASC
LIMIT 1
```

This is the core “next available task” rule.

### Events

`control-plane-supervision.md` contains the consolidated event vocabulary for the rewrite. The graph-specific payload semantics below remain the graph contract for dependency and supersession history.

New/changed event contracts:

| Event             | `task_id`   | Payload                                                                                |
| ----------------- | ----------- | -------------------------------------------------------------------------------------- |
| `task.created`    | new task id | existing fields plus `depends_on_task_ids: string[]` and optional `supersedes_task_id` |
| `task.superseded` | old task id | `new_task_id`, `reason`, `retargeted_dependent_task_ids`                               |
| `task.cancelled`  | old task id | `reason`, `superseded_by_task_id`                                                      |

## 6. Implementation Phases

### Phase 1: Schema and shared graph helpers (0.5-1 day)

- [x] Add `task_dependencies` and `task_supersessions` to initial schema
- [x] Add row decoders for new tables
- [x] Add a shared graph helper module for dependency reads and cycle checks

### Phase 2: Write-path changes (1-2 days)

- [x] Support repeatable `enqueue --depends-on`
- [x] Include dependency IDs in `task.created` payloads
- [x] Implement `pithos supersede`
- [x] Add cancellation write-path for superseded queued tasks

### Phase 3: Read-path and scheduling changes (1-2 days)

- [x] Make `claim` filter by dependency readiness
- [x] Extend `inspect task` with relationship output
- [x] Add `inspect graph`
- [x] Update `briefing` to show ready vs blocked work with blocker summaries
- [x] Update `tail` help/docs for new event types

### Phase 4: Verification and docs (0.5-1 day)

- [x] Add unit tests for cycle detection, supersede preconditions, and graph rendering
- [x] Add integration tests for cross-scope dependencies, claimability, and supersession rewrites
- [x] Update `packages/pithos/README.md` help surface and exit-code references
- [x] Run `pnpm verify`

## 7. Code Locations

| File                                         | Change                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/pithos/src/db/migrate.ts`          | Modify: add `task_dependencies` and `task_supersessions` to initial schema   |
| `packages/pithos/src/db/rows.ts`             | Modify: add relationship row decoders                                        |
| `packages/pithos/src/domain/task-graph.ts`   | New: graph queries, summaries, cycle detection, claimability helpers         |
| `packages/pithos/src/commands/enqueue.ts`    | Modify: repeated `--depends-on`, dependency validation, event payload update |
| `packages/pithos/src/commands/claim.ts`      | Modify: dependency-aware claim query                                         |
| `packages/pithos/src/commands/inspect.ts`    | Modify: relationship-aware task inspect; add graph inspect                   |
| `packages/pithos/src/commands/briefing.ts`   | Modify: blocked vs ready sections and blocker rendering                      |
| `packages/pithos/src/commands/supersede.ts`  | New: replacement flow                                                        |
| `packages/pithos/src/cli/commands.ts`        | Modify: wire new flags and subcommands into `--help`                         |
| `packages/pithos/src/commands/*.test.ts`     | Modify/add: unit coverage for new command contracts                          |
| `packages/pithos/test/*.integration.test.ts` | Modify/add: end-to-end SQLite coverage for DAG + supersession flows          |
| `packages/pithos/README.md`                  | Modify: document new command surface and semantics                           |

## 8. Open Questions

- Do we need an explicit future `pithos dependency waive` command for human-approved unblocking, or is `supersede` enough until a real workflow demands waivers?
