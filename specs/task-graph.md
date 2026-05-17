# Pithos Task Graph

**Status:** Implemented
**Last Updated:** 2026-05-16

## 1. Overview

### Purpose

Pithos owns the durable **Task graph** for Pandora's Box: Tasks, Dependencies, Source links, Supersessions, Claims, Runs, Artifacts, and Events. The graph lets Agents and Pandora understand what work exists, what is claimable, what is blocked, what replaced what, and what context belongs to a Task chain without relying on prompt memory or transcript scraping.

### Goals

- Store queue work as durable Tasks with exactly one Capability and Scope.
- Gate claimability with explicit Dependencies that are satisfied only by upstream Tasks in `done`.
- Preserve non-blocking provenance with Source links for continuation and repair contexts.
- Preserve replacement history with Supersessions instead of mutating old Task instructions in place.
- Enforce Claim, Held task, Fencing token, Attempt, and Run transition invariants in SQLite transactions.
- Provide readable and JSON inspection surfaces for Agents, Pandora, and scripts.
- Fail loudly on invalid graph references, stale Fencing tokens, superseded targets, invalid scopes, and malformed CLI payloads.

### Non-Goals

- No generic graph editor or arbitrary post-creation rewiring.
- No persisted Task chain object; chains are reconstructed from the Task graph.
- No `blocked` or `escalated` Task status; readiness and attention routing are derived from graph state and Capability.
- No priority scheduler beyond oldest claimable Task for a requested Scope/Capability.
- No silent rewrite from an old superseded Task id to its replacement.
- No payload side channels such as `--body`, `--body-file`, or `--result-file`; payload-bearing CLI commands use explicit `--stdin`.

## 2. Design Decisions

- **Decision:** Dependencies are first-class blocking edges in `task_dependencies`.
  - **Rationale:** Blocking is many-to-many, cross-scope, and must be queryable atomically during Claim selection.

- **Decision:** Source links are separate from Dependencies.
  - **Rationale:** An Escalation task often needs to point at work it is about while remaining immediately claimable by Pandora. `chain_source` supports ordinary continuation; `repair_source` points at broken work that must be superseded or explicitly replanned.

- **Decision:** Supersession replaces work with a fresh Task instead of editing the old Task.
  - **Rationale:** Prior Claims, Artifacts, Events, and prompt context must remain understandable. A fresh Task preserves the new instruction snapshot while retaining history.

- **Decision:** Claimability is computed, not stored.
  - **Rationale:** A queued Task becomes claimable when all Dependencies are `done`. A stored `blocked` state would drift from the graph.

- **Decision:** Pithos validates Scope row existence and current repo/worktree directory existence at write boundaries; pdx validates runtime paths again at launch.
  - **Rationale:** SQLite can enforce Scope references, but filesystem paths can disappear after a transaction commits.

- **Decision:** Read commands render Agent-readable text by default and structured JSON only behind `--json`.
  - **Rationale:** `task inspect`, `graph inspect`, and `briefing` are context surfaces for Agents. Protocol transition commands remain JSON-first because Agents need stable ids/tokens/results.

- **Decision:** CLI payloads are explicit stdin documents.
  - **Rationale:** `--stdin` avoids accidental blocking and gives Agents one consistent way to submit multiline Task bodies, replacement bodies, Artifact bodies, and optional completion metadata.

## 3. Core Behavior

### Claimability

A Task is claimable when:

- `tasks.status = 'queued'`
- the Task has no unresolved Dependency whose upstream status is not `done`
- the requested Run is authorized to claim the Task's Capability
- the requested Scope exactly matches the Run's Scope
- the Run has no current Held task

Claim increments Attempts, sets a fresh Fencing token, and stores the Held task pointer on the Run. A Run may hold at most one Task at a time.

### Chain policy

`pithos task enqueue` supports manual Dependencies with repeatable `--depends-on <task-id>` and implicit chain behavior with `--chain auto|none|held|source`.

- `auto` is the normal Agent default.
- `none` creates intentionally flat work except for explicit `--depends-on` flags.
- `held` requires a Held task and adds it as a Dependency.
- `source` requires a held Escalation task with a `chain_source` and depends on that source.

Automatic chaining keeps ordinary follow-up work connected, but Escalation tasks are not auto-blocked. Escalations created from held work receive a non-blocking `chain_source`; Repair Alerts receive a `repair_source` and must be repaired with Supersession or explicit replanning rather than ordinary continuation.

### Supersession

`pithos task supersede <task-id>` creates a fresh replacement Task, copies upstream Dependencies, records a Supersession edge, and rewires direct queued dependents to the replacement. Cancelled dependents are ignored. Direct dependents in any other state cause the transaction to fail loudly so already-started work is not silently retargeted.

If the old Task is still queued, it becomes `cancelled` in the same transaction. Claimed/running Tasks cannot be superseded; interrupt the live Run first.

### Payload CLI contract

Payload-bearing public CLI commands use one explicit stdin document:

| Command                                | Payload rule                                                 |
| -------------------------------------- | ------------------------------------------------------------ |
| `pithos task enqueue ... --stdin`      | required non-empty Task body                                 |
| `pithos task supersede ... --stdin`    | required non-empty replacement Task body                     |
| `pithos task artifact add ... --stdin` | required non-empty Artifact body                             |
| `pithos task complete ... [--stdin]`   | optional JSON object completion metadata; omitted means `{}` |

The CLI reads stdin only when `--stdin` is present. Missing redirected stdin, empty required payloads, invalid completion JSON, and conflicting `--run`/`PITHOS_RUN_ID` fail with tagged Pithos errors.

## 4. Inspection Surfaces

### `pithos task inspect <task-id> [--json]`

Readable output is the normal Agent handoff for a single Task. It includes the current Task, direct Dependencies and dependents, nearby upstream Dependency lineage, Artifacts, Source link context, Supersession context, and computed claimability. JSON returns the structured version of the same durable context for scripts and exact field use.

### `pithos graph inspect (--task <id>|--scope <id>|--all) [filters] [--json]`

Graph inspect selects seed Tasks, then returns a closed graph over Dependencies, Source links, and Supersessions. Filters narrow seed selection before closure:

- repeatable `--status`: OR over Task statuses
- repeatable `--search`: AND over case-insensitive Task title/body substrings
- `--since`: `today`, `<n>h`, `<n>d`, `YYYY-MM-DD`, or ISO timestamp with timezone

When no `--status`, `--search`, or `--since` filter is present, `--scope` and `--all` seed selection omits cancelled Tasks completed more than one hour ago. Those stale cancelled Tasks can still appear when closure from selected Tasks references them. Use an explicit filter such as `--status cancelled` when Pandora needs older cancelled Tasks as seeds.

Closure may include related Tasks that do not match filters so blockers, provenance, and replacement history remain understandable. Scope graphs intentionally do not pull global Repair Alerts into repo/worktree views through reverse `repair_source` closure; inspect the affected Task directly or use `--all` when Pandora needs that provenance.

### `pithos briefing [--agent pandora] [--json]`

Briefing owns agenda questions: ready work, blocked work, recent completions, and Pandora-oriented summaries. Use graph inspect for graph inventory, provenance, and audit; use briefing for what needs attention next.

## 5. Data Model and Code Locations

The durable schema and Engine implementation live in:

- `packages/pithos/src/db.ts` — schema, migrations, seeded built-ins
- `packages/pithos/src/engine.ts` — state transitions and inspection operations
- `packages/pithos/src/chain-policy.ts` — chain, dependency, source, supersession helpers
- `packages/pithos/src/cli.ts` — public CLI and help JSON
- `packages/pithos/src/rows.ts` — SQLite row parsing
- `packages/pithos/test/` — SQLite-backed behavior coverage

Key tables include `tasks`, `runs`, `task_dependencies`, `task_sources`, `task_supersessions`, `artifacts`, and `events`. The package README documents module boundaries; generated CLI help is the command syntax source.

## 6. Testing

Automated coverage lives in:

- `packages/pithos/test/task-lifecycle.test.ts` — Task transitions, Claims, chain policy, Supersession, Repair Alert behavior
- `packages/pithos/test/chain-policy.test.ts` — pure graph/chain policy behavior
- `packages/pithos/test/cli.test.ts` — CLI parsing, help JSON, stdin payload contract, output contracts
- `packages/pithos/test/foundation.test.ts` — schema and seed invariants
