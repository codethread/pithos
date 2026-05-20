# Task Graph Typed Edges Diff

**Status:** Planned
**Last Updated:** 2026-05-19

> This is a temporary diff spec to evaluate a breaking Task graph redesign. It is
> intentionally written as an overlay on top of `task-graph.md`,
> `control-plane-supervision.md`, and `UBIQUITOUS_LANGUAGE.md`. If accepted, merge
> the decisions back into those specs and remove this diff spec.

## 1. Overview

### Purpose

Replace the current split between blocking Dependencies and non-blocking Source
links with one typed Task edge model. The new model keeps claimability computed
from the graph, adds a dynamic coordination gate that waits for an evolving
branch to drain, and makes escalation/repair routing ordinary graph structure
instead of special Source-link side behavior.

### Goals

- Preserve the current direct dependency behavior as an `after` edge.
- Add a `gate` edge for “wait until the target branch drains” without making the
  gated task part of that branch.
- Replace `chain_source` with `about` edges for immediate attention/context.
- Replace `repair_source` with `repair` edges for broken-work repair alerts.
- Make edge direction, branch closure, gate satisfaction, supersession, and late
  branch growth explicit enough for implementation and Agent inspection.
- Keep Task chain as an inferred story; do not introduce persisted chain rows or
  chain status.

### Non-Goals

- No persisted Task chain/workstream object.
- No stored `blocked` Task status; claimability remains computed.
- No priority scheduler, root-admission limits, or scope holds in this change.
- No arbitrary graph editor or post-creation rewiring beyond existing
  Supersession-style repair.
- No automatic inference of `gate`; Agents/operators must request it explicitly.
- No generic relation taxonomy beyond the four edge kinds listed here.

## 2. Design Decisions

- **Decision:** Use one typed edge table for blocking, gate, context, and repair
  relationships.
  - **Rationale:** The Task graph is the durable source of truth. A unified edge
    model makes escalation and repair inspectable with the same graph machinery as
    ordinary dependencies instead of preserving a “dependency table plus source
    side table” split. This is accepted as a breaking DB change.

- **Decision:** Keep edge direction as “edge owner points at target.”
  - **Rationale:** This matches today’s `task_dependencies.task_id -> depends_on_task_id`
    and Source-link usage. Claimability for a task reads its outgoing edges;
    branch closure from an anchor traverses incoming membership edges.

- **Decision:** Split local blocking from branch membership.
  - **Rationale:** `about` and `repair` do not block the escalation/repair task
    itself, but they intentionally attach that task to the target branch so a
    `gate` waiting on the branch sees unresolved attention/repair work. This is a
    product choice, not an accidental side effect.

- **Decision:** `gate` waits on dynamic branch closure, not one direct task.
  - **Rationale:** The motivating case is a branch that grows after the gate is
    created. A direct dependency on the current terminal task can unblock too
    early; a gate over branch closure follows later `after`/attention/repair work.

- **Decision:** `gate` edges do not create branch membership.
  - **Rationale:** Otherwise `target --gate--> downstream` would make downstream
    part of the target branch and can create self-blocking closure semantics.
    Gates connect branches for scheduling only.

- **Decision:** Only `done` drains a branch member.
  - **Rationale:** A branch with `failed`, `cancelled`, or `dead_letter` work did
    not successfully resolve. Downstream gated work should remain blocked and be
    surfaced as waiting on a broken branch until Pandora/Toil repairs or replans.

- **Decision:** Supersession is the only transparent replacement path.
  - **Rationale:** A superseded old task may be `cancelled` as part of replacement;
    that cancellation should not permanently poison gates. Ordinary cancelled work
    without a Supersession remains broken for gate purposes.

- **Decision:** Gate release is recorded per Claim attempt.
  - **Rationale:** Gate claimability is dynamic before Claim, and Tasks may be
    requeued and claimed again. Pithos must record which gate checks released for
    each attempt, plus the closure snapshot used for that release, so late branch
    growth and repeated Claims remain auditable.

## 3. Architecture

### Edge model

Every edge is carried by `task_id` and points to `target_task_id`:

```text
new/follow-up task --edge-kind--> referenced target task
```

| Kind     | Blocks `task_id`?               | Adds `task_id` to target branch? | Replaces current concept              |
| -------- | ------------------------------- | -------------------------------- | ------------------------------------- |
| `after`  | Yes, until target is `done`     | Yes                              | `task_dependencies` direct dependency |
| `gate`   | Yes, until target branch drains | No                               | New coordination primitive            |
| `about`  | No                              | Yes                              | `task_sources.kind = chain_source`    |
| `repair` | No                              | Yes                              | `task_sources.kind = repair_source`   |

### Edge direction examples

```text
b --after--> a
c --after--> b
```

Means `b` waits for `a`, `c` waits for `b`, and the branch closure rooted at `a`
contains `a`, `b`, and `c`.

```text
attention --about--> c
```

Means `attention` is claimable immediately, but it is attached to `c`'s branch.
A gate waiting on `c` will not release while this attention task is unresolved.

```text
next_feature --gate--> c
```

Means `next_feature` waits until the branch rooted at `c` drains, but
`next_feature` does not become part of `c`'s branch.

### Branch closure

For an anchor task `A`, branch closure is computed by fixed-point traversal:

```text
closure = { canonical(A) }
repeat:
  for each edge E where canonical(E.target_task_id) is in closure
      and E.kind in { after, about, repair }:
    add canonical(E.task_id) to closure
until closure stops growing
```

`gate` edges are excluded from branch closure.

`canonical(task)` follows Supersession replacement chains to the latest active
replacement for closure and gate-satisfaction checks. Superseded old tasks remain
visible in inspection history, but their cancelled status does not block gates
when a replacement exists.

### Gate satisfaction

A `gate` edge from task `T` to anchor `A` is satisfied when every canonical task
in `branchClosure(A)` has status `done`.

Gate states for inspection:

| Closure contents                                                                                   | Gate state | Claimability effect                                          |
| -------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| all canonical members are `done`                                                                   | clear      | gate does not block                                          |
| any member is `queued`, `claimed`, running                                                         | open       | gated task is not claimable                                  |
| any member is `failed`, `cancelled`, or `dead_letter` without transparent Supersession replacement | broken     | gated task is not claimable; briefing surfaces broken branch |

### Dynamic gate behavior

Gate checks are dynamic while the gated task is queued. If new branch-member work
is added under the anchor before Claim, the gate may regress from clear to open.
That is intentional: the downstream task has not started yet, so it should wait
for the newly discovered branch work.

When a task with one or more `gate` edges is claimed, Pithos evaluates all gates
inside the Claim transaction. If they are clear, Pithos records gate releases for
that task attempt before completing the Claim. The release snapshot is durable
audit that “this downstream attempt started after these branch members were
done.”

A task returning to `queued` after Cleanup/Interrupt keeps historical release
rows, but the next Claim records a new release row keyed by the next Attempt. Old
release rows do not make the next Claim valid.

### Late branch growth after gate release

Adding an `after`, `about`, or `repair` edge under a released gate anchor, or
superseding a canonical member of a released gate closure, can invalidate
assumptions for downstream work that has already started. Pithos must therefore
check branch-member edge creation and Supersession against released gate records.

A released gate is affected by proposed upstream growth when the canonical target
of a new branch-membership edge is present in that release's member snapshot or
current `branchClosure(release.target_task_id)`. Superseding any canonical member
in the release snapshot or current closure is affected by the same rule.

For each affected release, define the downstream impact closure from the gate
owner:

```text
impact = { canonical(gate_owner) }
repeat:
  add branch members reachable through incoming after/about/repair edges
  add owners of already-released gate edges whose target is in impact
until impact stops growing
```

If any task in that downstream impact closure is non-terminal (`queued`,
`claimed`, or `running`), the upstream growth fails loudly. The operator/Agent
must interrupt, supersede, or explicitly replan the active downstream work before
adding upstream branch work that would have invalidated it. If all tasks in the
impact closure are terminal, the new upstream edge or Supersession is allowed,
and Pithos records a durable `task_gate_late_growth_markers` row so inspection
can mark it as late branch growth after a prior gate release. This keeps the race
visible without permanently freezing old branches against all future related
work.

### Graph integrity

Pithos validates edges at insertion time using canonical task ids:

- The branch-membership graph formed by `after/about/repair` edges must be
  acyclic.
- A `gate` edge is invalid when the gate owner is already in
  `branchClosure(target)`.
- The blocking graph formed by direct `after` edges and direct `gate` targets must
  be acyclic, so multi-task gate cycles such as `a --gate--> b` and
  `b --gate--> a` fail loudly.
- `about` and `repair` are mutually exclusive and singular per task.

### Escalation forms

Escalation remains an ordinary Task with `capability = escalate`; the edge kind
states why Pandora is being pulled in.

| Form                  | Edge shape                        | Claimability        | Workflow meaning                                                                 |
| --------------------- | --------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| Immediate escalation  | `escalation --about--> target`    | immediate           | Human attention/context about in-flight or planned work                          |
| Checkpoint escalation | `escalation --gate--> target`     | after branch drains | Human checkpoint after successful branch completion                              |
| Repair Alert          | `repair_alert --repair--> target` | immediate           | Broken-work repair; Pandora should supersede/replan/cancel, not continue blindly |

`repair` is not just “about but broken.” It preserves current Repair Alert
semantics: broken chains are repaired with Supersession, explicit replanning, or
intentional cancellation rather than ordinary continuation.

`about` and `repair` are singular branch-attention anchors for a task. A task may
have at most one of these edges so continuation policy never has to choose among
multiple branch anchors. Fan-in work should use repeatable `after` or `gate`
edges instead.

## 4. Data Model

Breaking DB reset is accepted for this diff. No migration from existing user DBs
is required if the change lands pre-v1.

### `task_edges`

```sql
CREATE TABLE task_edges (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  target_task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('after', 'gate', 'about', 'repair')),
  created_by_run_id TEXT NOT NULL REFERENCES runs(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, target_task_id, kind),
  CHECK (task_id <> target_task_id)
);

CREATE INDEX idx_task_edges_target_kind
  ON task_edges(target_task_id, kind);

CREATE INDEX idx_task_edges_task_kind
  ON task_edges(task_id, kind);

CREATE UNIQUE INDEX idx_task_edges_one_attention_anchor
  ON task_edges(task_id)
  WHERE kind IN ('about', 'repair');
```

`created_by_run_id` preserves the current `task_sources.source_run_id` audit
property and extends it to all edge kinds. The partial unique index keeps
`about`/`repair` singular and mutually exclusive for deterministic continuation
policy.

### `task_gate_releases`

```sql
CREATE TABLE task_gate_releases (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  target_task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL,
  fencing_token INTEGER NOT NULL,
  released_by_run_id TEXT NOT NULL REFERENCES runs(id),
  released_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, target_task_id, attempt)
);

CREATE TABLE task_gate_release_members (
  task_id TEXT NOT NULL,
  target_task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  member_task_id TEXT NOT NULL REFERENCES tasks(id),
  canonical_task_id TEXT NOT NULL REFERENCES tasks(id),
  status_at_release TEXT NOT NULL,
  PRIMARY KEY (task_id, target_task_id, attempt, member_task_id),
  FOREIGN KEY (task_id, target_task_id, attempt)
    REFERENCES task_gate_releases(task_id, target_task_id, attempt)
);

CREATE TABLE task_gate_late_growth_markers (
  id TEXT PRIMARY KEY,
  gate_task_id TEXT NOT NULL,
  gate_target_task_id TEXT NOT NULL,
  gate_attempt INTEGER NOT NULL,
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('edge_inserted', 'supersession')),
  edge_task_id TEXT REFERENCES tasks(id),
  edge_target_task_id TEXT REFERENCES tasks(id),
  edge_kind TEXT CHECK (edge_kind IN ('after', 'about', 'repair')),
  superseded_task_id TEXT REFERENCES tasks(id),
  replacement_task_id TEXT REFERENCES tasks(id),
  created_by_run_id TEXT NOT NULL REFERENCES runs(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (gate_task_id, gate_target_task_id, gate_attempt)
    REFERENCES task_gate_releases(task_id, target_task_id, attempt)
);
```

A release exists only for `gate` edges and is written in the same transaction as
Claim. It is audit/state for late-growth checks; it does not make queued tasks
claimable by itself. Release members snapshot the closure evaluated for that
attempt so later graph growth or Supersession cannot erase what was checked.
Late-growth markers are durable inspection/read-model records, not events; they
are written only when upstream growth is allowed after all downstream impact work
is terminal.

### Supersession

`task_supersessions` remains separate. It is not a generic edge kind because it
is replacement history, not a claimability relation.

Rules:

- Supersession rewires queued direct `after` and `gate` edge owners from old
  target to replacement, preserving edge kind.
- `about` and `repair` edges are not retargeted by Supersession because they are
  durable provenance for the work or broken task that caused attention.
- Branch closure and gate satisfaction canonicalize superseded tasks to their
  latest replacement, including when an `about` or `repair` edge still points at
  the old task for provenance.
- A superseded old task's cancellation does not count as broken gate closure when
  the replacement path exists.
- Direct edge owners in non-queued/non-cancelled states still fail loudly as
  today so started work is not silently retargeted.
- Superseding any canonical member beneath a released gate is treated like late
  branch growth and must pass the released-gate check above.

## 5. Interfaces

### CLI shape

The breaking CLI should prefer edge-oriented flags:

| Flag                  | Edge kind | Description                                          |
| --------------------- | --------- | ---------------------------------------------------- |
| `--after <task-id>`   | `after`   | This task waits for the target task directly.        |
| `--gate-on <task-id>` | `gate`    | This task waits for the target branch to drain.      |
| `--about <task-id>`   | `about`   | This task is immediate attention/context for target. |
| `--repair <task-id>`  | `repair`  | System-authored Repair Alert edge for target.        |

`--after` and `--gate-on` are repeatable blocking edges. `--about` and
`--repair` are singular and mutually exclusive; an escalation or repair alert has
one branch-attention anchor. Fan-in coordination should use repeatable `--after`
or `--gate-on` edges. `--repair` is restricted to the `pdx` system actor and
must fail loudly for ordinary Agent runs so Repair Alerts remain system-authored.

`--chain auto|none|held` remains enqueue policy sugar during the first
implementation. The old `source` policy is removed by this breaking change;
Agents should use explicit typed edge flags instead.

- ordinary held-task continuation creates `after` edges
- held normal task to escalation creates `about`
- held `about` or `gate` escalation to normal continuation creates `after` to the
  held escalation; the escalation's edge keeps the continuation attached to the
  relevant branch or checkpoint
- held `repair` escalation cannot ordinary-auto-continue; `--chain auto` fails
  loudly and the Agent must repair with Supersession, explicit replanning, or
  intentional cancellation
- repair alerts create `repair`
- `--chain none` creates no implicit edges; manual flags still apply

### Claimability

A task is claimable when:

- `tasks.status = 'queued'`
- all outgoing `after` targets canonicalize to status `done`
- all outgoing `gate` target branch closures are clear
- the requested Run is authorized for the Capability
- the requested Scope exactly matches the Run Scope
- the Run has no current Held task

### Inspection

`task inspect`, `graph inspect`, and `briefing` must render the four edge kinds
separately.

Minimum `task inspect` grouping:

```text
Direct after dependencies:
- task_x [done]

Coordination gates:
- task_c [open]
  Open branch members:
  - task_d queued
  - task_e claimed

Attached context:
- about task_c
- repair task_failed_branch
```

`graph inspect --json` must include edge kind and gate state. Readable graph
output should distinguish branch membership edges (`after/about/repair`) from
coordination gates (`gate`) so a gate does not appear as ordinary chain history.

Scope-seeded graph inspection changes from the current Repair Alert exception:
seed selection still respects the requested Scope, but closure may include
global `about`/`repair` escalation tasks attached to selected scoped work because
those edges are branch membership in the typed-edge model. It should also include
global checkpoint escalations whose `gate` target is in the selected scoped
closure, rendered as coordination gates rather than branch members.

### Events

`task.created` payload should record edge arrays by kind rather than a flat
`depends_on_task_ids` list. Gate release should emit a distinct event, for
example `task.gate_released`, with the gated task id, target anchor id, attempt,
fencing token, release run id, and release member snapshot ids.

## 6. Implementation Phases

### Phase 1: Schema and read model

- [ ] Replace `task_dependencies` and `task_sources` with `task_edges` in the
      fresh schema.
- [ ] Add `task_gate_releases` and `task_gate_release_members`.
- [ ] Update row parsing and read-model helpers to expose typed edges.
- [ ] Preserve edge authorship through `created_by_run_id`.

### Phase 2: Enqueue, chain policy, and repair alerts

- [ ] Replace direct dependency insertion with `after` insertion.
- [ ] Replace `chain_source` insertion with `about` insertion.
- [ ] Replace `repair_source` insertion with `repair` insertion.
- [ ] Update `resolveChainPolicy` output to describe implicit typed edges.
- [ ] Update Repair Alert creation to use `repair` edges.

### Phase 3: Claimability and gate closure

- [ ] Implement branch-closure traversal over incoming `after/about/repair` edges.
- [ ] Implement gate clear/open/broken state calculation.
- [ ] Update Claim selection to reject candidates with uncleared gates.
- [ ] Record per-attempt gate releases and release-member snapshots in the Claim
      transaction.
- [ ] Enforce late-branch-growth and Supersession checks for released gates with
      active downstream work.

### Phase 4: Supersession and graph integrity

- [ ] Preserve edge kinds during per-kind supersession rewiring.
- [ ] Canonicalize superseded tasks in branch closure and gate checks.
- [ ] Reject membership cycles, direct gate self-dependencies, and multi-task
      gate/blocking cycles.
- [ ] Update graph closure and unresolved-blocker helpers.

### Phase 5: CLI, prompts, docs, and tests

- [ ] Add `--after`, `--gate-on`, `--about`, and `--repair` CLI flags.
- [ ] Update generated command cards and Agent templates.
- [ ] Update `task inspect`, `graph inspect`, and `briefing` renderers.
- [ ] Add SQLite-backed tests for gate growth, branch drain, repair, supersession,
      and late-growth enforcement.
- [ ] Merge this diff into `task-graph.md`, `control-plane-supervision.md`, and
      `UBIQUITOUS_LANGUAGE.md`; then delete this diff spec.

## 7. Code Locations

| File/Directory                        | Planned change                                              |
| ------------------------------------- | ----------------------------------------------------------- |
| `packages/pithos/src/db.ts`           | Fresh schema: `task_edges`, `task_gate_releases`            |
| `packages/pithos/src/chain-policy.ts` | Output typed implicit edges instead of dependencies/sources |
| `packages/pithos/src/engine.ts`       | Enqueue/supersede integration and event payloads            |
| `packages/pithos/src/engine/*`        | Claim loop, read models, graph inspect, rendering           |
| `packages/pithos/src/cli.ts`          | New edge flags and help JSON                                |
| `packages/pithos/test/`               | Behavior coverage for typed edges and gates                 |
| `packages/pdx/src/`                   | Repair Alert launch/precondition call-site updates          |
| `resources/data-dir/templates/`       | Agent instructions for edge flags and gate semantics        |
| `specs/task-graph.md`                 | Merge final Task graph model after acceptance               |
| `specs/control-plane-supervision.md`  | Merge final escalation/Repair Alert model                   |
| `UBIQUITOUS_LANGUAGE.md`              | Rename Dependency/Source-link terms to typed edges          |

## 8. Open Questions

- Should `about` and `repair` remain singular branch-membership edges forever, or
  should a later non-membership context edge exist for purely historical
  annotation?
- How much of gate closure should be materialized for performance? The planned
  model computes it transactionally; implementation may need recursive CTEs or a
  cached read model if claim queries become expensive.
