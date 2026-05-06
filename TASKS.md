# TASKS

Context: implement the planned task-graph work in [`specs/task-graph.md`](./specs/task-graph.md).

## Pickup instructions for implementation agents

Read these before starting any slice:

- `specs/task-graph.md`
- `packages/cli/AGENTS.md`
- `packages/cli/README.md`
- `packages/cli/CONTRIBUTING.md`
- the touched command/db/test files for your slice

Assume no hidden context beyond this file and the docs above.

## Global contracts

These rules apply to every slice unless a slice says otherwise:

- Tasks are effectively immutable. Do not update task `title`, `body`, `capability`, or dependency edges in place except where the spec explicitly defines a supersession rewrite.
- Cross-scope dependencies are allowed. A task in one scope may depend on a task in another scope.
- A dependency is satisfied only when the blocking task is `done`.
- `claim` still searches only the requested `--scope` and `--capability`; only blocker resolution spans scopes.
- `queued` is still the only claimable task status. “Blocked” is computed, not stored.
- New dependency targets that already have a superseding replacement must fail loudly; do not silently retarget.
- Graph/event/read APIs are agent-facing contracts. Deterministic output matters.
- For every slice: update command help, unit/integration tests, and any user-facing package docs touched by the surface change.

## User stories

- **US1** — create tasks that depend on other tasks
- **US2** — let dependencies span scopes/repos
- **US3** — `pithos claim` only returns next available work
- **US4** — inspect what blocks a task / scope / graph
- **US5** — replace a wrong middle task with a new one, preserving history
- **US6** — agents can explain and act on graph state from CLI output

## Approved vertical slices

### 1. Direct dependency authoring + task inspect
- **Type:** AFK
- **Status:** complete
- **Blocked by:** none
- **User stories covered:** US1, US2, US4, US6
- **Primary files:**
  - `packages/cli/src/db/migrate.ts`
  - `packages/cli/src/db/rows.ts`
  - `packages/cli/src/domain/task-graph.ts` (new)
  - `packages/cli/src/commands/enqueue.ts`
  - `packages/cli/src/commands/inspect.ts`
  - `packages/cli/src/cli/commands.ts`
  - related unit + integration tests
- **Scope:**
  - add `task_dependencies`
  - add migration/backfill guardrails for legacy `parent_id`
  - replace `enqueue --parent-id` with repeatable `--depends-on`
  - reject cycles, duplicate deps, and deps targeting superseded tasks
  - extend `inspect task` with direct dependencies, dependents, unresolved blockers
  - update tests, help text, and docs
- **Must implement exactly:**
  - migration preflight: if any unfinished task (`queued`, `claimed`, `running`) still has non-null `parent_id`, fail migration loudly and list offending task IDs; do not guess how to convert them
  - remediation rule for failed migration: operator must finish/cancel/re-enqueue those tasks after upgrade; migration only backfills remaining `parent_id` rows
  - `enqueue --depends-on <task-id>` is repeatable and cross-scope
  - duplicate dependency IDs are `VALIDATION_ERROR`
  - dependency targets must exist
  - if a dependency target has already been superseded, `enqueue` fails with a tagged user-facing error that points at the replacement task
  - resulting graph must remain acyclic before commit
  - `inspect task <id>` must return machine-readable JSON including:
    - the task
    - `dependencies`: direct blockers with `id`, `scope_id`, `status`, `title`
    - `dependents`: direct downstream tasks with the same summary shape
    - `task.claimable`
    - `task.unresolved_dependency_ids`
    - `supersedes`: `null | { id, scope_id, status, title }`
    - `superseded_by`: `null | { id, scope_id, status, title }`
    - `artifacts`
  - `parent_id` must not appear in the `inspect task` response contract
  - relationship arrays are sorted by the related task row's `created_at`, then related task `id`
- **Done when:**
  - cross-scope dependency authoring works end-to-end
  - `inspect task` explains direct blockers in JSON without requiring graph reconstruction from prose
  - integration coverage proves bad dependency inputs fail loudly

### 2. Ready-only claim + blocked/ready briefing
- **Type:** AFK
- **Status:** complete
- **Blocked by:** 1
- **User stories covered:** US2, US3, US4, US6
- **Primary files:**
  - `packages/cli/src/commands/claim.ts`
  - `packages/cli/src/commands/briefing.ts`
  - `packages/cli/src/cli/commands.ts`
  - related tests
- **Scope:**
  - make `claim` ignore blocked queued tasks while still selecting only from the requested scope/capability
  - preserve FIFO ordering among claimable tasks
  - update `briefing` to split ready vs blocked work
  - show blocker task ids, scopes, and statuses in blocked output
  - update tests, help text, and docs
- **Must implement exactly:**
  - `claim` query still filters by requested `--scope` and `--capability`
  - a queued task is claimable only when all dependency targets are `done`, even if those blockers live in other scopes
  - blocked tasks remain `queued`; no new persisted `blocked` status
  - `briefing` keeps the current top-level structure (`Needs Adam`, `Ready for review`, `Active`, `Stale / failed`)
  - within `### Active`, render in this order:
    - ready queued tasks
    - blocked queued tasks
    - claimed/running tasks
  - ready and blocked queued tasks are each ordered by task `created_at`, then task `id`
  - blocked tasks must list all direct unresolved blockers, ordered by blocker task `created_at`, then blocker task `id`
  - each blocker summary includes blocker task id, blocker scope id, and blocker status
- **Done when:**
  - `pithos claim` only returns queued tasks whose deps are all `done`
  - older blocked tasks do not starve newer ready tasks
  - `pithos briefing` distinguishes ready work from blocked work with enough detail for Pandora/agents to route follow-up

### 3. Task-centric graph inspection
- **Type:** AFK
- **Status:** complete
- **Blocked by:** 1, 4
- **User stories covered:** US2, US4, US6
- **Primary files:**
  - `packages/cli/src/domain/task-graph.ts`
  - `packages/cli/src/commands/inspect.ts`
  - `packages/cli/src/cli/commands.ts`
  - related tests
- **Scope:**
  - add `pithos inspect graph --task <id>`
  - return a closed JSON graph with nodes, edges, claimable state, and unresolved blockers
  - traverse dependencies recursively across scopes
  - update tests, help text, and docs
- **Must implement exactly:**
  - selector: `--task <id>` only
  - traversal: follow dependency and supersession edges in both directions recursively until the returned graph is closed
  - graph closure rule: every `from_task_id`, `to_task_id`, `supersedes_task_id`, and `superseded_by_task_id` in the response must refer to a node present in `graph.nodes`
  - graph node contract includes:
    - `id`, `scope_id`, `capability`, `status`, `title`
    - `claimable`
    - `unresolved_dependency_ids`
    - `supersedes_task_id`
    - `superseded_by_task_id`
  - graph edge contract includes:
    - `{ kind: "depends_on", from_task_id, to_task_id, satisfied }`
    - `{ kind: "supersedes", from_task_id, to_task_id }`
  - ordering:
    - nodes sorted by task `created_at`, then task `id`
    - edges sorted by `kind`, then `from_task_id`, then `to_task_id`
- **Done when:**
  - a single task can be inspected as a transitive dependency/supersession graph
  - graph output is deterministic and suitable for agent consumption
  - returned graphs are closed under all emitted references

### 4. Supersede a wrong middle task
- **Type:** AFK
- **Status:** complete
- **Blocked by:** 1
- **User stories covered:** US5, US6
- **Primary files:**
  - `packages/cli/src/db/migrate.ts`
  - `packages/cli/src/db/rows.ts`
  - `packages/cli/src/domain/task-graph.ts`
  - `packages/cli/src/commands/supersede.ts` (new)
  - `packages/cli/src/commands/inspect.ts`
  - `packages/cli/src/cli/commands.ts`
  - related tests
- **Scope:**
  - add `task_supersessions`
  - add `pithos supersede <task-id>`
  - create a replacement task with fresh runtime state
  - retarget direct queued dependents to the replacement
  - cancel the old queued task and emit supersession/cancel events
  - expose supersession links in `inspect task`
  - update tests, help text, and docs
- **Must implement exactly:**
  - command surface:
    - `pithos supersede <task-id> --run <run-id> --reason <text>`
    - optional overrides: `--title`, `--body`, `--body-file`, `--scope`, `--capability`
  - reject if old task:
    - does not exist
    - is `claimed` or `running`
    - already has a supersession row
  - dependent handling:
    - direct queued dependents are retargeted from old task to new task
    - cancelled direct dependents are ignored
    - any other direct dependent status causes the transaction to fail loudly
  - replacement task creation contract:
    - copy only `scope_id`, `capability`, `title`, `body`, `payload_json`, `max_attempts`
    - apply explicit CLI overrides
    - reset operational fields to fresh-task values: `status='queued'`, no lease owner/until, `fencing_token=0`, `attempts=0`, `result_json='{}'`, `completed_at=NULL`, fresh timestamps
    - set `created_by_run_id` to the actor run
  - copy old task’s direct upstream dependency edges to the replacement before rewiring dependents
  - if old task was `queued`, cancel it in the same transaction
  - emit events for new task creation, supersession, and queued-task cancellation
  - final graph must be acyclic before commit
  - `inspect task` must now populate `supersedes` / `superseded_by` using the same summary object shape: `{ id, scope_id, status, title }`
- **Done when:**
  - `a -> b -> c` can become `a -> d -> c` with preserved history
  - invalid supersede attempts fail loudly before partial rewrites
  - the old task remains explainable via inspect/event history

### 5. Graph inspection for scopes and live work
- **Type:** AFK
- **Status:** complete
- **Blocked by:** 3, 4
- **User stories covered:** US2, US4, US6
- **Primary files:**
  - `packages/cli/src/domain/task-graph.ts`
  - `packages/cli/src/commands/inspect.ts`
  - `packages/cli/src/cli/commands.ts`
  - related tests
- **Scope:**
  - add `pithos inspect graph --scope <id>`
  - add `pithos inspect graph --live`
  - include dependency and supersession closure rules
  - keep node/edge ordering deterministic
  - update tests, help text, and docs
- **Must implement exactly:**
  - `--scope <scope-id>`:
    - seed with all non-cancelled tasks in that scope
    - walk dependency and supersession edges in both directions recursively until the response is closed
  - `--live`:
    - include all non-cancelled tasks
    - include any referenced dependency or supersession neighbors needed to keep the response closed, even if those neighbors are cancelled
  - reuse the same node/edge schema and ordering rules as slice 3
- **Done when:**
  - agents can inspect a scope-level graph or the whole live graph directly from CLI JSON
  - returned graphs are closed under all emitted references
  - cancelled supersession/dependency neighbors appear when needed to explain the live graph

### 6. Tail/event contract completion
- **Type:** AFK
- **Status:** pending
- **Blocked by:** 1, 4
- **User stories covered:** US4, US5, US6
- **Primary files:**
  - `packages/cli/src/commands/enqueue.ts`
  - `packages/cli/src/commands/supersede.ts`
  - `packages/cli/src/commands/tail.ts`
  - `packages/cli/src/cli/commands.ts`
  - related tests
- **Scope:**
  - ensure `task.created`, `task.superseded`, and `task.cancelled` payloads match the spec
  - update `tail` surfaces, examples, and help text
  - add event-focused integration coverage for graph changes end-to-end
- **Must implement exactly:**
  - `task.created` payload includes existing fields plus:
    - `depends_on_task_ids: string[]`
    - optional `supersedes_task_id`
  - `task.superseded` payload includes:
    - `new_task_id`
    - `reason`
    - `retargeted_dependent_task_ids`
  - `task.cancelled` payload includes:
    - `reason`
    - `superseded_by_task_id`
  - `tail` docs/examples must mention the new event shapes so agents can audit graph history
- **Done when:**
  - agents can audit graph creation and supersession history via `pithos tail`
  - event payloads are stable, documented, and covered by integration tests
