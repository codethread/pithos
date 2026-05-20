# Pithos Task Graph

**Status:** Implemented
**Last Updated:** 2026-05-20

## 1. Overview

Pithos owns the durable **Task graph** for Pandora's Box: Tasks, typed Task edges, Supersessions, Claims, Runs, Artifacts, Events, and inspection surfaces. The graph lets Agents and Pandora understand what work exists, what is claimable, what is waiting on branch completion, what replaced what, and what context belongs to a Task chain without relying on prompt memory.

## 2. Typed Task edges

Every durable relationship between Tasks uses `task_edges` with direction:

```text
new/follow-up task --edge-kind--> referenced target task
```

| Kind     | Blocks owner?                   | Adds owner to target branch? | Meaning                                          |
| -------- | ------------------------------- | ---------------------------- | ------------------------------------------------ |
| `after`  | Yes, until target is `done`     | Yes                          | Direct prerequisite.                             |
| `gate`   | Yes, until target branch drains | No                           | Coordination checkpoint over an evolving branch. |
| `about`  | No                              | Yes                          | Immediate attention/context about target work.   |
| `repair` | No                              | Yes                          | System-authored Repair Alert for broken work.    |

`after` and `gate` are repeatable. `about` and `repair` are singular and mutually exclusive for one Task so continuation policy has one branch-attention anchor.

### Branch closure

For an anchor Task `A`, branch closure starts at `canonical(A)` and traverses incoming `after`, `about`, and `repair` edges until no more canonical owners are found. `gate` edges are excluded from branch membership.

`canonical(task)` follows Supersession replacement chains to the latest replacement for closure and gate checks. Superseded old Tasks remain inspectable history; their cancellation does not poison a gate when a replacement exists.

### Gate claimability and release

A `gate` edge from owner `T` to anchor `A` is satisfied when every canonical member of `branchClosure(A)` is `done`.

Inspection states:

| State    | Closure contents                                                              | Effect                                                           |
| -------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `clear`  | all canonical members are `done`                                              | gate no longer blocks                                            |
| `open`   | any member is queued/claimed/running                                          | owner is not claimable                                           |
| `broken` | any member is failed/cancelled/dead-lettered without transparent Supersession | owner is not claimable and inspection surfaces the broken branch |

Gate checks are dynamic while the owner is queued. New `after`/`about`/`repair` work under the anchor before Claim can move a gate from clear back to open.

When a gated Task is claimed, Pithos evaluates gates inside the Claim transaction and records `task_gate_releases` plus `task_gate_release_members` for that attempt. Historical release rows are audit snapshots; a later requeue requires a fresh release for the next attempt. Pithos emits `task.gate_released` with task id, target anchor, attempt, fencing token, releasing run, and snapshot members.

### Late branch-growth protection

After a gate release, adding branch-member growth (`after`, `about`, `repair`) beneath the released anchor or superseding a released/current branch member can invalidate downstream work. Pithos checks affected released gates inside the mutation transaction.

If any task in the downstream impact closure from the gate owner is non-terminal, the mutation fails loudly. The Agent/operator must interrupt, supersede, or explicitly replan active downstream work first. If all impacted downstream work is terminal, the mutation is allowed and Pithos records a `task_gate_late_growth_markers` row so inspection can show late branch growth after a prior release.

### Graph integrity

Pithos validates edges at insertion time using canonical Task ids:

- `after`/`about`/`repair` branch-membership edges are acyclic.
- A `gate` owner cannot already be in `branchClosure(target)`.
- The blocking graph formed by direct `after` edges and direct `gate` targets is acyclic.
- `about` and `repair` are singular and mutually exclusive per Task.

## 3. Claimability

A Task is claimable when:

- `tasks.status = 'queued'`
- all outgoing `after` targets canonicalize to `done`
- all outgoing `gate` target branch closures are clear
- the requested Run is authorized for the Capability
- the requested Scope exactly matches the Run Scope
- the Run has no current Held task

Claim increments Attempts, sets a fresh Fencing token, stores the Held task on the Run, and records gate release snapshots when gates release. A Run may hold at most one Task at a time.

## 4. Chain policy and CLI shape

`pithos task enqueue` exposes edge-oriented flags:

| Flag                  | Edge kind | Description                                               |
| --------------------- | --------- | --------------------------------------------------------- |
| `--after <task-id>`   | `after`   | This Task waits for the target Task directly.             |
| `--gate-on <task-id>` | `gate`    | This Task waits for the target branch to drain.           |
| `--about <task-id>`   | `about`   | This Task is immediate attention/context for target work. |
| `--repair <task-id>`  | `repair`  | System-authored Repair Alert edge for target work.        |

`--repair` is restricted to the `pdx` system actor. Ordinary Agents must route broken work through the implemented Repair Alert flows.

`--chain auto|none|held` is enqueue policy sugar:

- ordinary held-task continuation creates `after`
- held ordinary work to escalation creates `about`
- held `about` or `gate` escalation to ordinary continuation creates `after` to the held escalation; the escalation edge keeps branch/checkpoint context attached
- held `repair` escalation cannot ordinary-auto-continue; `--chain auto` fails loudly and Pandora must repair with Supersession, explicit replanning, or intentional cancellation
- `--chain none` creates no implicit edges, though manual edge flags still apply

Requested `review` Tasks are ordinary non-escalation work claimed by Greed. Reviews are usually created with `after` edges to the work they assess; fan-in reviews use repeatable `--after`.

## 5. Supersession

`pithos task supersede <task-id>` creates a fresh replacement Task, records replacement history in `task_supersessions`, and may cancel the old queued Task in the same transaction.

Rules:

- queued direct `after` and `gate` owners are retargeted from old target to replacement, preserving edge kind
- `about` and `repair` edges stay attached to the original Task for provenance
- branch closure and gate satisfaction canonicalize superseded Tasks to latest replacements
- direct edge owners in non-queued/non-cancelled states fail loudly so started work is not silently retargeted
- superseding a member beneath a released gate must pass the late-growth check

Supersession is replacement history, not a generic edge kind.

## 6. Payload CLI contract

Payload-bearing public CLI commands use one explicit stdin document:

| Command                                | Payload rule                                                 |
| -------------------------------------- | ------------------------------------------------------------ |
| `pithos task enqueue ... --stdin`      | required non-empty Task body                                 |
| `pithos task supersede ... --stdin`    | required non-empty replacement Task body                     |
| `pithos task artifact add ... --stdin` | required non-empty Artifact body                             |
| `pithos task complete ... [--stdin]`   | optional JSON object completion metadata; omitted means `{}` |

The CLI reads stdin only when `--stdin` is present. Missing redirected stdin, empty required payloads, invalid completion JSON, and conflicting `--run`/`PITHOS_RUN_ID` fail with tagged Pithos errors.

## 7. Inspection surfaces

### `pithos task inspect <task-id> [--json]`

Readable output is the normal Agent handoff for a single Task. It separates direct `after` blockers/dependents, `gate` coordination state and branch members, attached `about`/`repair` context, Supersession context, late-growth markers, Artifacts, and computed claimability. JSON returns the structured version of the same durable context.

### `pithos graph inspect (--task <id>|--scope <id>|--all) [filters] [--json]`

Graph inspect selects seed Tasks, then returns a closed graph over typed edges and Supersessions. Filters narrow seed selection before closure:

- repeatable `--status`: OR over Task statuses
- repeatable `--search`: AND over case-insensitive Task title/body substrings
- `--since`: `today`, `<n>h`, `<n>d`, `YYYY-MM-DD`, or ISO timestamp with timezone

Closure may include related Tasks that do not match filters so blockers, attached context, gates, and replacement history remain understandable. Scope graph inspection may include global `about`/`repair` escalation Tasks attached to selected scoped work, and global checkpoint escalations whose `gate` target is in selected scoped closure. Readable output distinguishes branch-membership edges (`after`/`about`/`repair`) from coordination gates (`gate`). JSON includes edge kind and gate state.

### `pithos briefing [--agent pandora] [--json]`

Briefing owns agenda questions: ready work, blocked/gated work, broken branches, recent completions, and Pandora-oriented summaries. Use graph inspect for graph inventory, provenance, and audit; use briefing for what needs attention next.

## 8. Data model and code locations

Key tables include `tasks`, `runs`, `task_edges`, `task_gate_releases`, `task_gate_release_members`, `task_gate_late_growth_markers`, `task_supersessions`, `artifacts`, and `events`. `runs.has_claimed_task` is the durable record that a Run has claimed work, so timeout/launch-abort semantics do not depend on retained event history. Event rows are retention-managed operational history and may be pruned by age through the Engine library boundary.

Implementation lives in:

- `packages/pithos/src/db.ts` — schema, migrations, seeded built-ins
- `packages/pithos/src/engine.ts` and `packages/pithos/src/engine/*` — transitions, typed-edge read models, graph inspection, rendering, gate checks, Repair Alerts, Events
- `packages/pithos/src/chain-policy.ts` — typed-edge chain, branch closure, acyclicity, and Supersession helpers
- `packages/pithos/src/cli.ts` — public CLI and help JSON
- `packages/pithos/src/rows.ts` — SQLite row parsing
- `packages/pithos/test/` — SQLite-backed behavior coverage

The package README documents module boundaries; generated CLI help is the command syntax source.

## 9. Testing

Automated coverage lives in:

- `packages/pithos/test/task-lifecycle.test.ts` — Task transitions, Claims, typed edges, gates, Supersession, Repair Alert behavior
- `packages/pithos/test/chain-policy.test.ts` — pure graph/chain policy behavior
- `packages/pithos/test/cli.test.ts` — CLI parsing, help JSON, stdin payload contract, output contracts
- `packages/pithos/test/render.test.ts` — typed-edge readable graph/task/briefing rendering snapshots
- `packages/pithos/test/foundation.test.ts` — schema and seed invariants
