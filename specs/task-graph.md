# Task Graph

**Status:** Implemented
**Last Updated:** 2026-05-11

## 1. Overview

### Purpose

Pithos tasks use a first-class dependency DAG plus a linear supersession history. This lets agents create cross-scope blocked work, claim only ready tasks, replace a wrong middle task with a new one without mutating task contents, and inspect the current chain/graph through readable context views or explicit machine-readable JSON.

### Goals

- Allow any task to depend on zero or more existing tasks.
- Allow dependency edges to span scopes freely.
- Make `pithos task claim` return only queued tasks whose dependencies are all `done`.
- Preserve history when one task replaces another.
- Let agents inspect blockers, dependents, artifacts, recent lineage, and the current connected graph without reconstructing relationships from prose.
- Surface ready versus blocked work in `pithos briefing`.
- Preserve task-chain lineage automatically for ordinary follow-up enqueues from a run that already holds work.
- Preserve escalation provenance without making escalation tasks block on the work they are meant to unblock.

### Non-Goals

- A generic mutable graph editor for arbitrary post-creation rewiring.
- In-place mutation of task `title`, `body`, or `capability` to preserve history.
- Priority scheduling, critical-path scheduling, or any optimizer beyond FIFO among claimable tasks.
- Performance work for large graphs or remote databases; correctness and clarity win.
- Automatic downstream repair once work has already started from superseded input.
- Inferring semantic relationships for unrelated operator/Pandora “Q” requests; those must stay intentionally flat unless the user or Pandora names a source.
- Treating escalation source links as readiness gating. Escalations must remain immediately claimable even when they point at source work.

### Task graph vs task chain

A **task graph** is the full durable relationship model Pithos stores and inspects. It includes tasks, blocking dependency edges, non-blocking source links, supersession history, artifacts, runs, and events. The graph is the interrogation substrate: it answers what exists, how work is related, why a task is blocked, what replaced what, and what evidence was attached.

A **task chain** is the product-facing work thread the user and agents discuss: the delegation path from initial triage through design, escalation/review, execution, result review, and repair. A chain is reconstructed from the task graph; it is not a separate persisted object and does not need to be strictly linear.

A **dependency** is a blocking edge: downstream work waits for the upstream task to be `done`. A **source link** is non-blocking provenance: this task is about, or came from, a source task. Both help reconstruct the chain, but only dependencies affect claimability.

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

- **Decision:** Add an engine-owned enqueue chaining policy instead of relying on prompts to remember `--depends-on`.
  - **Rationale:** The engine already resolves the actor run and knows whether that run holds a task. Forgetting `--depends-on` silently creates flat islands, while the engine can derive the ordinary follow-up edge transactionally and report what it did.

- **Decision:** Split blocking dependencies from non-blocking source links.
  - **Rationale:** A dependency means “do not claim this task until the upstream task is `done`.” Escalations need to point at the work they are about without waiting for that work, so they need a source link rather than a `task_dependencies` row.

- **Decision:** Make `--chain auto` the default, with explicit `none`, `held`, and `source` modes.
  - **Rationale:** Normal agents should get lineage by omission. Pandora needs an obvious escape hatch for unrelated user “Q” requests. `held` and `source` remain fail-loud CLI modes for operators or advanced recipes, but routine agent prompts should teach default `auto` plus explicit `none`, not the whole mode matrix.

- **Decision:** Manual `--depends-on` edges combine with implicit chain edges unless `--chain none` is selected.
  - **Rationale:** Fan-in is common: a follow-up can naturally depend on the held triage/design task and on additional named prerequisites. `--chain none --depends-on <task-id>` remains the manual-only form.

- **Decision:** Pandora’s user-facing “Q” convention defaults to `--chain none`, while checkpoint/approval escalation-resolution handoffs rely on default `auto` when resolving a held escalation with a `chain_source`.
  - **Rationale:** Pandora is long-lived and may hold an escalation while the user asks for unrelated work. Those operator-created tasks must not all inherit the same graph origin. When Pandora is resolving a successful checkpoint/approval escalation, `auto` uses the `chain_source` link to choose the correct dependency target. Repair escalations use `repair_source` and must be superseded or explicitly replanned instead. `--chain source` remains available when a caller wants a fail-loud assertion that a chain source exists, but it should not be the default prompt recipe.

- **Decision:** Read-only context commands render agent-readable Markdown/text by default and require `--json` for full structured output.
  - **Rationale:** `task inspect`, `graph inspect`, and `briefing` are context surfaces agents paste into their reasoning loop. The default should be compact and readable while preserving task IDs for drill-down. Full objects remain available for scripts and tests through a single explicit format flag. Lifecycle/protocol commands such as `claim`, `enqueue`, and `complete` remain JSON-default because agents need stable IDs, tokens, and transition results.

- **Decision:** Scope-row existence is a database invariant; scope runtime-path existence is boundary validation.
  - **Rationale:** SQLite can and must prevent tasks from referencing missing scope rows. Filesystem paths are mutable outside the database, so Pithos validates repo/worktree directories at scope and task write boundaries, while pdx validates them again immediately before launch.

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
enqueue
  -> resolve actor run and optional held task
  -> resolve chain policy into dependency edges and/or source links
  -> validate referenced runs/scopes/tasks
  -> validate target scope exists, is active, and has a current directory when repo/worktree-scoped
  -> transaction writes task + relationship rows + events
  -> commit only if resulting dependency graph is acyclic

supersede
  -> validate referenced runs/scopes/tasks
  -> validate replacement scope exists, is active, and has a current directory when repo/worktree-scoped
  -> transaction writes replacement task + relationship rows + events
  -> commit only if resulting dependency graph is acyclic

claim
  -> transaction selects oldest queued task in requested scope/capability
  -> filter out tasks with unresolved dependencies across any scope
  -> claim task + emit event

inspect/briefing
  -> query current tasks + task_dependencies + task_supersessions
  -> compute claimability and unresolved blockers at read time
  -> print readable Markdown/text by default or structured JSON with --json
```

### Schema deployment

The initial schema (migration 1) creates the graph tables — `tasks`, `task_dependencies`, `task_supersessions`, `task_sources`, etc. The `tasks` table does not include `parent_id`; blocking edges and source links are explicit relationship tables.

## 4. Data Model

### Scope admission contract

Task rows must always reference an existing scope row. The `tasks.scope_id REFERENCES scopes(id)` foreign key is the final database backstop, and Pithos performs an explicit scope lookup before task creation so CLI and library callers receive a tagged validation error instead of a raw SQLite error.

`repo` and `worktree` scopes are runtime-scoped: their `canonical_path` must point at an existing directory when the scope is upserted and when new work is enqueued or superseded into that scope. A file, missing path, or broken symlink is invalid. The caller must create or restore the directory first, then run `pithos scope upsert --kind repo|worktree --path <path>`.

Directory existence is not a durable database invariant because the filesystem can change after a transaction commits. Pithos validates it at write boundaries to reject already-invalid work; pdx validates it again at launch time to catch stale scopes whose directories were removed after task creation.

Error contract:

- Missing or archived scope: fail with tagged JSON and a message that says the scope is not active and must be created/reactivated with `pithos scope upsert` first.
- Missing/non-directory repo or worktree path: fail with tagged JSON and a message that says to create the directory first, then upsert the scope.

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

CREATE TABLE IF NOT EXISTS task_sources (
  task_id        TEXT PRIMARY KEY REFERENCES tasks(id),
  source_task_id TEXT NOT NULL REFERENCES tasks(id),
  source_run_id  TEXT NOT NULL REFERENCES runs(id),
  kind           TEXT NOT NULL CHECK (kind IN ('chain_source', 'repair_source')),
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (task_id <> source_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_sources_source
  ON task_sources(source_task_id);
```

`task_sources.source_run_id` is the actor run that created/asserted the source link, not necessarily a run that ever claimed the source task. Normal agent chaining uses the creating agent run. Supervisor-created repair escalations use the `pdx` system run, which is valid even when the source task was never claimed.

`task_sources.kind` controls how prompts and chain policy treat the source:

- `chain_source` means ordinary continuation may depend on the source when the held escalation is resolved.
- `repair_source` means the source is broken or unlaunchable provenance; agents must repair it with supersession/replan rather than enqueueing ordinary follow-up that depends on it.

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
	| {
			kind: "source";
			from_task_id: string;
			to_task_id: string;
			source_kind: "chain_source" | "repair_source";
	  }
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
	source_task_id: string | null;
};
```

These are response-contract types, not a directive to mirror them 1:1 in source.

## 5. Interfaces

### CLI commands

> Note: `control-plane-supervision.md` supersedes the command paths, capability vocabulary, and authorization requirements below. The graph semantics in this spec remain normative, but the post-rewrite public surface uses nested commands such as `pithos task enqueue`, `pithos task claim`, `pithos task inspect`, and `pithos graph inspect`, with capabilities limited to `triage`, `design`, `execute`, and `escalate`.

| Command                           | Change           | Contract                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pithos task enqueue`             | Modify           | Support repeatable manual `--depends-on <task-id>` plus `--chain auto\|none\|held\|source`. All referenced dependency/source tasks must exist. Duplicate dependency IDs fail validation. Requires a resolved run, `--stdin` with non-empty body, known capability, active target scope with current repo/worktree directory when applicable, and `agent_enqueues` authorization. |
| `pithos task claim`               | Modify semantics | Claim the oldest queued task matching `--scope` and `--capability` whose dependencies are all `done`. Exit code stays `5` for “no claimable work”. Requires `agent_claims` authorization, matching run scope, and no existing held task.                                                                                                                                         |
| `pithos task inspect <id>`        | Expand output    | Render an agent-readable Markdown handoff by default; `--json` returns full root task detail, artifacts, direct dependencies, direct dependents, upstream dependency lineage, unresolved blockers, and immediate supersession links.                                                                                                                                             |
| `pithos graph inspect`            | New              | Render a readable dependency/source/supersession overview by default for one selector: `--task <id>`, `--scope <scope-id>`, or `--all`; `--json` returns the full closed graph object.                                                                                                                                                                                           |
| `pithos task supersede <task-id>` | New              | Create a replacement task with an explicit `--stdin` replacement body, copy the old task’s upstream dependencies, retarget direct queued dependents, record supersession history, and cancel the old task if it was still queued.                                                                                                                                                |
| `pithos briefing`                 | Modify output    | Render a readable ready/blocked briefing by default; `--json` returns ready and blocked arrays with blocker task IDs/scopes/statuses.                                                                                                                                                                                                                                            |
| `pithos tail`                     | New event types  | Surface `task.superseded` and `task.cancelled` events introduced by replacement flows.                                                                                                                                                                                                                                                                                           |

### `pithos task enqueue`

New flag surface:

| Flag                     | Description                                                               | Default                       |
| ------------------------ | ------------------------------------------------------------------------- | ----------------------------- |
| `--scope <scope-id>`     | Scope for the new task                                                    | required                      |
| `--capability <cap>`     | Capability for matching agents: `triage`, `design`, `execute`, `escalate` | required                      |
| `--title <title>`        | Human-readable title for the task                                         | required                      |
| `--stdin`                | Read task body from redirected stdin                                      | required                      |
| `--run <run-id>`         | Creating run; defaults from `PITHOS_RUN_ID` for spawned agents            | required after env resolution |
| `--depends-on <task-id>` | Manual blocking dependency edge; repeatable                               | none                          |
| `--chain <mode>`         | Implicit chaining policy: `auto`, `none`, `held`, or `source`             | `auto`                        |

Behavioral rules:

- all dependency targets must already exist
- dependency targets may be in any scope
- if a dependency target has already been superseded, `enqueue` must fail with a tagged user-facing error that points at the replacement task; the command must not silently rewrite to a different task ID
- duplicate dependency IDs are rejected with `VALIDATION_ERROR` after manual and implicit dependencies are combined
- source targets must exist; if a source target has already been superseded, creating a source link must fail with a tagged error pointing at the replacement
- the creating run must exist and its agent kind must be authorized in `agent_enqueues` for the requested capability
- manual/operator enqueue without a resolved run is not exposed
- `--stdin` is required, stdin must be redirected, and decoded body length must be non-zero; capability-specific scope/body rules from `control-plane-supervision.md` apply
- the transaction must fail if the resulting dependency graph would contain a cycle
- `task.created` event payload must include `depends_on_task_ids` and chain/source metadata

A successful enqueue returns the applied chain decision so agents can see whether the task is intentionally flat, implicitly chained, or source-linked:

```json
{
	"ok": true,
	"task": { "id": "task_new", "status": "queued" },
	"chain": {
		"policy": "auto",
		"applied": "depends_on_source",
		"held_task_id": "task_escalation",
		"source_task_id": "task_design",
		"final_dependency_ids": ["task_design"]
	}
}
```

#### Chain policy

`--chain` controls implicit relationships derived from the actor run's currently held task. `--depends-on` controls explicit manual blocking dependencies. The final blocking dependency set is:

```text
final_dependencies = manual --depends-on ids + implicit ids from --chain
```

Use `--chain none --depends-on <task-id>` for manual-only dependencies.

| Mode     | Contract                                                                                                                                                                                                                                                                  | Failure cases                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`   | Default. For ordinary held work, add a dependency on the held task. For held ordinary work enqueueing `escalate`, add no dependency and record the held task as a `chain_source`. For a held escalation with a `chain_source`, ordinary follow-up depends on that source. | No held task is not an error; the task is flat and output says no chain was applied. Fails loudly if the held escalation has a `repair_source`; the caller must supersede or explicitly replan instead. |
| `none`   | Add no implicit dependency and no source. Manual `--depends-on` flags still apply.                                                                                                                                                                                        | None beyond normal dependency validation.                                                                                                                                                               |
| `held`   | Require the actor run to hold a task and add that held task as a blocking dependency.                                                                                                                                                                                     | Fails if the run holds no task, or if the new task is `escalate` because escalations must not block on held work.                                                                                       |
| `source` | Require the held task to have a `chain_source` and add that source task as a blocking dependency.                                                                                                                                                                         | Fails if the run holds no task, the held task has no source, the held source is a `repair_source`, or the new task is `escalate`.                                                                       |

Automatic chaining treats capabilities as two classes:

| Held task                           | New task                    | `--chain auto` result                                 |
| ----------------------------------- | --------------------------- | ----------------------------------------------------- |
| none                                | any                         | no implicit edge                                      |
| `triage`/`design`/`execute`         | `triage`/`design`/`execute` | `new --depends_on--> held`                            |
| `triage`/`design`/`execute`         | `escalate`                  | no dependency; `new --chain_source--> held`           |
| `escalate` with `chain_source` `S`  | `triage`/`design`/`execute` | `new --depends_on--> S`                               |
| `escalate` with `repair_source` `S` | `triage`/`design`/`execute` | fail loudly; supersede/replan `S` explicitly          |
| `escalate` without source           | `triage`/`design`/`execute` | no implicit edge; output says no source was available |
| `escalate`                          | `escalate`                  | no implicit edge                                      |

Escalations are never auto-blocked. An explicit `--depends-on` on an escalation is allowed only when the caller intentionally wants a blocked escalation; agent prompts must not use it for normal attention routing.

#### Relationship scenarios

Normal triage-to-execute handoff:

```text
T triage [claimed by Toil]

Toil enqueues E execute with --chain auto

E execute ──depends_on──▶ T triage
```

Manual fan-in while preserving the held-task chain:

```text
T triage [claimed]
D design [queued/done]

Toil enqueues E execute with --depends-on D and --chain auto

E execute ──depends_on──▶ T triage   # implicit
E execute ──depends_on──▶ D design   # manual
```

Manual-only or intentionally flat work:

```text
Pandora and the user queue unrelated work with --chain none

Q triage
# no implicit dependency/source link
```

Escalation from held design:

```text
D design [claimed by Greed]

Greed enqueues A escalate with --chain auto

A escalate ──source──────▶ D design   # non-blocking provenance
# no depends_on edge, so Pandora can claim A immediately
```

Pandora resolving that escalation after approval:

```text
A escalate [claimed by Pandora] ──source──▶ D design [done/approved]

Pandora enqueues H triage with default --chain auto
# --chain source is an optional fail-loud assertion, not the routine prompt recipe

H triage ──depends_on──▶ D design
```

Full design-review chain:

```text
             non-blocking attention/provenance
A escalate ─────────────source────────────▶ D design
                                             ▲
                                             │ blocking execution lineage
H triage / execute ─────depends_on──────────┘
```

Pandora's user-facing Q convention:

```text
Pandora holds A escalate ──source──▶ D design

the user: "Q this unrelated polish idea"
Pandora enqueues P triage with --chain none

P triage
# intentionally flat; does not inherit D as origin
```

Pandora has three distinct intents while holding an escalation:

| Pandora intent                                                                               | Required/default chain mode                                                                                                                                                                                 | Result                                                   |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Resolve a held checkpoint/approval escalation by routing approved `chain_source` work onward | default `--chain auto`; optional `--chain source` only when a fail-loud source assertion is desired                                                                                                         | new task blocks on the source task                       |
| Repair a held interruption or launch-precondition escalation with `repair_source`            | use `pithos task supersede <source-task>` after fixing the issue, or use `--chain none`/manual dependencies for explicit replans; `--chain auto` and `--chain source` fail loudly for ordinary continuation | source task is replaced or chain is explicitly replanned |
| user says “Q this” without naming the held escalation/source as context                      | `--chain none` by Pandora prompt/Q convention                                                                                                                                                               | new task is intentionally flat                           |
| user says “Q this for task_X”                                                                | `--chain none --depends-on task_X`                                                                                                                                                                          | manual dependency on the named task only                 |

The engine cannot infer the user's conversational intent, so the Pandora prompt/Q convention must make unrelated Qs flat by default. Raw `task enqueue` keeps `--chain auto` as the universal default for agents; Pandora uses `--chain none` when acting as the user's general queueing interface. Routine agent prompts should present this as a two-mode surface: omit `--chain` for ordinary chain continuation, use `--chain none` for intentionally unrelated work.

### `pithos task supersede <task-id>`

Required/optional surface:

| Flag / arg           | Description                                    | Default                       |
| -------------------- | ---------------------------------------------- | ----------------------------- |
| `<task-id>`          | Task being replaced                            | required                      |
| `--run <run-id>`     | Actor performing the replacement               | required after env resolution |
| `--title <title>`    | Replacement task title                         | old task title                |
| `--stdin`            | Replacement task body from redirected stdin    | required                      |
| `--scope <scope-id>` | Replacement task scope                         | old task scope                |
| `--capability <cap>` | Replacement task capability                    | old task capability           |
| `--reason <text>`    | Human-readable reason stored with supersession | required                      |

Transaction contract:

1. Validate old task exists.
2. Validate actor run exists.
3. Reject if old task status is `claimed` or `running`.
4. Reject if the old task already has a `task_supersessions` row; a task may be superseded at most once.
5. Load direct dependents of the old task.
6. Reject if any direct dependent has status other than `queued` or `cancelled`. Cancelled dependents are ignored rather than retargeted.
7. Create the new task with this exact contract:
   - copy from old task: `scope_id`, `capability`, `title`, `max_attempts`
   - set `body` from required redirected stdin; old body inheritance is not part of the public CLI contract
   - apply explicit CLI overrides on `scope_id`, `capability`, and `title`
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

Default output is an agent-readable Markdown handoff. It expands the current task and the nearest two upstream dependency-lineage tasks, nesting each task's artifacts under the task that produced them. Older ancestors are intentionally omitted from the local window but remain discoverable because every rendered task row includes its task id; agents can inspect any upstream or downstream task id to move the context window along the chain.

Example default shape:

````markdown
# task_c [execute] [claimed] Update FE client

## Recent history

### task_a [triage] [done] Approve API direction

Body:

```md
approved API sketch
```

Artifact artifact_1 [design-brief] API brief:

```md
...
```

### task_d [design] [done] Fix API

Body:

```md
Fix API
```

## Current task

### task_c [execute] [claimed] Update FE client

Body:

```md
update the FE client for task_d
```

Depends on:

- task_d [design] [done] Fix API

Unlocks:

- task_e [execute] [blocked] Publish follow-up docs
````

`--json` success response shape:

```json
{
	"ok": true,
	"task": {
		"id": "task_c",
		"scope_id": "repo:fe",
		"capability": "execute",
		"status": "queued",
		"body": "update the FE client for task_d",
		"fencing_token": 0,
		"attempts": 0,
		"max_attempts": 3,
		"claimable": false,
		"unresolved_dependency_ids": ["task_d"]
	},
	"dependencies": [
		{ "id": "task_d", "scope_id": "repo:be", "status": "queued", "title": "Fix API" }
	],
	"dependents": [],
	"lineage": [
		{
			"depth": 2,
			"via_task_ids": ["task_d"],
			"task": {
				"id": "task_a",
				"scope_id": "global",
				"capability": "triage",
				"status": "done",
				"body": "approved API sketch",
				"fencing_token": 0,
				"attempts": 0,
				"max_attempts": 3,
				"claimable": false,
				"unresolved_dependency_ids": []
			},
			"supersedes": null,
			"superseded_by": null,
			"artifacts": []
		},
		{
			"depth": 1,
			"via_task_ids": ["task_c"],
			"task": {
				"id": "task_d",
				"scope_id": "repo:be",
				"capability": "execute",
				"status": "queued",
				"body": "Fix API",
				"fencing_token": 0,
				"attempts": 0,
				"max_attempts": 3,
				"claimable": false,
				"unresolved_dependency_ids": ["task_a"]
			},
			"supersedes": null,
			"superseded_by": null,
			"artifacts": [
				{
					"id": "artifact_1",
					"kind": "design-brief",
					"title": "API brief",
					"body": "...",
					"created_at": "2026-05-11 14:00:00"
				}
			]
		}
	],
	"supersedes": null,
	"superseded_by": null,
	"artifacts": []
}
```

Requirements:

- `task` is full task detail (`body`, `fencing_token`, `attempts`, `max_attempts`) plus computed `claimable` and `unresolved_dependency_ids`
- `lineage` walks `task_dependencies` upstream only; it never traverses dependents, supersession edges, or non-blocking source links
- each lineage entry appears once at its shortest upstream depth; `via_task_ids` lists the child task ids through which that shortest-depth ancestor is reached
- `lineage` is sorted by `depth DESC`, then task `created_at ASC`, then task `id ASC`
- direct `dependencies`, direct `dependents`, and artifact arrays remain deterministic and sorted by `created_at`, then `id`
- dependency/dependent summaries must always include `scope_id`
- source summaries, when present, include `id`, `scope_id`, `status`, `title`, and `source_kind` (`chain_source` or `repair_source`)
- readable inspect output labels source links as continuation or repair provenance so agents can distinguish normal handoff from supersession/replan work
- `claimable` and `unresolved_dependency_ids` are computed, never stored

### `pithos graph inspect`

Selectors are mutually exclusive:

| Selector             | Result                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--task <id>`        | Transitive closure around that task following dependency, source, and supersession edges both directions                                                          |
| `--scope <scope-id>` | Seed with all non-cancelled tasks in that scope, then walk dependency, source, and supersession edges in both directions recursively until the response is closed |
| `--all`              | All non-cancelled tasks and all current graph edges, plus any referenced dependency or source or supersession neighbors needed to keep the response closed        |

Output flags:

| Flag     | Effect                                                                           |
| -------- | -------------------------------------------------------------------------------- |
| `--json` | Return the full closed graph object instead of the readable overview             |
| `--all`  | Selector: inspect every non-cancelled task and graph neighbor needed for closure |

Default readable graph output renders dependency edges as an indented tree, includes each task's capability and effective status, and labels queued tasks with unresolved dependencies as `[blocked]`. `--all` is selection, not output format; scripts use `--json`.

Graph closure requirement:

- every `from_task_id`, `to_task_id`, `source_task_id`, `supersedes_task_id`, and `superseded_by_task_id` emitted in the response must refer to a node present in `graph.nodes`
- this may require including source neighbors or cancelled supersession neighbors when they are referenced by returned edges or node fields

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

| Event             | `task_id`   | Payload                                                                                                                                                                                    |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `task.created`    | new task id | existing fields plus `depends_on_task_ids: string[]`, optional `supersedes_task_id`, and chain metadata (`chain_policy`, `chain_applied`, `source_task_id`, `source_kind`, `held_task_id`) |
| `task.superseded` | old task id | `new_task_id`, `reason`, `retargeted_dependent_task_ids`                                                                                                                                   |
| `task.cancelled`  | old task id | `reason`, `superseded_by_task_id`                                                                                                                                                          |

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

### Phase 5: Automatic enqueue chaining

- [x] Add `--chain auto|none|held|source` to `pithos task enqueue`.
- [x] Add source-link storage for non-blocking escalation origins.
- [x] Resolve chain policy inside `engine.enqueue` after actor-run authorization and before dependency validation.
- [x] Include chain/source metadata in enqueue output and `task.created` events.
- [x] Extend `task inspect` and `graph inspect` to show source links without treating them as lineage dependencies.
- [x] Update agent templates so normal agents rely on auto chaining, Pandora Qs use `--chain none`, and escalation-resolution handoffs rely on default auto; keep `held`/`source` out of routine prompt recipes except as advanced/fail-loud CLI modes.
- [x] Add CLI/engine tests for the chain-policy matrix and prompt help snapshots.

## 7. Code Locations

| File                                                                         | Change                                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ------------------------------------------------------- |
| `packages/pithos/src/engine.ts`                                              | Modify: resolve chain policy, persist source links, include chain metadata in enqueue output/events, and include source links in inspect/graph reads |
| `packages/pithos/src/cli.ts`                                                 | Modify: add `--chain auto                                                                                                                            | none | held | source`to`task enqueue` and thread it into engine input |
| `packages/pithos/src/db.ts`                                                  | Modify: add non-blocking source-link table in the clean-break schema                                                                                 |
| `packages/pithos/src/rows.ts`                                                | Modify: add source-link row decoder if source rows are parsed outside engine-local query shapes                                                      |
| `packages/pithos/test/task-lifecycle.test.ts`                                | Modify/add: cover auto chaining, explicit/manual combinations, escalation source behavior, Pandora source handoff, and `--chain none`                |
| `packages/pithos/test/cli.test.ts`                                           | Modify: cover CLI flag parsing/help for `--chain` and enqueue output contract                                                                        |
| `templates/_common.md`                                                       | Modify: document automatic chain behavior and replace routine manual `--depends-on <held-task-id>` recipes                                           |
| `templates/pandora.md.tmpl`                                                  | Modify: distinguish escalation-resolution handoffs (default auto from held escalation source) from user-facing unrelated Qs (`--chain none`)         |
| `templates/toil.md.tmpl`, `templates/greed.md.tmpl`, `templates/war.md.tmpl` | Modify only if role-specific wording is needed; routine prompt surface should remain default auto plus explicit none for unrelated work              |
| `packages/pithos/README.md`                                                  | Modify: document `task enqueue --chain` and source-vs-dependency semantics                                                                           |

## 8. Open Questions

- Do we need an explicit future `pithos dependency waive` command for human-approved unblocking, or is `supersede` enough until a real workflow demands waivers?
- Should explicit `--depends-on` plus default `--chain auto` always combine, or should any manual dependency imply `--chain none`? Current design chooses combination for fan-in, with `--chain none` as the manual-only escape hatch.
- Should source links be limited to a single source task per task, or should future graph inspection support multiple non-blocking sources? Current design chooses one source to keep Pandora escalation routing simple.
