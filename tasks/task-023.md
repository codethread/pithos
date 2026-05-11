# Task 023: Pure chain graph policy core

## Scope

Type: AFK

Create a pure in-memory graph/chain policy core for automatic task chaining and source-link behavior, with broad fast tests that do not require SQLite.

This slice should make the tricky graph semantics cheap to test: dependency-vs-source behavior, chain policy decisions, duplicate detection, acyclicity, lineage exclusion of source links, and graph closure rules should be expressed over plain data structures before later slices wire the behavior through DB and CLI.

## Must implement exactly

- Add a small pure module under the Pithos source boundary for task graph / chain policy operations.
- Model only the data needed for decisions: task id, capability, status, held task id, source task id, manual dependency ids, and existing dependency/source/supersession edges.
- Implement a pure chain-policy resolver for `auto`, `none`, `held`, and `source` that returns:
  - implicit dependency ids
  - optional source link target
  - applied/no-op reason metadata
  - validation failures as typed/tagged domain errors, not silent fallbacks
- Implement pure helpers or fixtures for dependency acyclicity, duplicate final dependency detection, upstream dependency lineage, and graph closure that includes source/supersession neighbors without treating sources as lineage blockers.
- Add many fast Vitest cases around the pure module. Cover at minimum:
  - no held task + auto is intentionally flat
  - ordinary held task + ordinary follow-up auto depends on held
  - ordinary held task + escalation auto creates source link only
  - held escalation with source + ordinary follow-up auto depends on source
  - held escalation without source + ordinary follow-up auto no-ops with visible reason
  - held escalation + escalation auto no-ops
  - `none` never adds implicit dependency or source
  - `held` succeeds only with held ordinary follow-up and fails otherwise
  - `source` succeeds only with held source and non-escalate follow-up and fails otherwise
  - manual dependency plus implicit dependency combines for fan-in
  - duplicate manual+implicit dependency is rejected
  - source links do not appear in dependency lineage or unresolved blockers
  - graph closure includes source-linked nodes and supersession neighbors
  - dependency cycles are rejected but source links alone do not create dependency cycles
- Keep tests deterministic and independent of timestamps, ID generation, filesystem, subprocesses, and SQLite.

## Done when

- The pure graph/chain policy test file exercises the full chain matrix and source-vs-dependency semantics without opening a database.
- Later engine slices can call the pure resolver instead of reimplementing chain decisions inline.
- Existing pithos tests still pass.

## Out of scope

- CLI flag parsing.
- DB schema changes or migrations.
- Persisting source links.
- Updating prompts or docs.
- Rewriting all existing engine graph queries; only extract what is needed to support automatic chaining safely.

## References

- `specs/task-graph.md`
- `UBIQUITOUS_LANGUAGE.md`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
