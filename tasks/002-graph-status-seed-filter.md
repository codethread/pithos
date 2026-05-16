# Task 2: Graph status seed filter

## Scope

Type: AFK

Add repeatable literal task-status filtering to `pithos graph inspect`. The filter selects seed tasks by exact task status before graph closure expands related dependency, source, and supersession context.

## Must implement exactly

- Add repeatable `--status <queued|claimed|running|done|failed|dead_letter|cancelled>` to `pithos graph inspect`.
- Accept only literal task statuses; do not add aliases such as `active`, `open`, `terminal`, `ready`, `blocked`, or `broken`.
- Repeated `--status` values compose with OR for seed selection.
- Different selector constraints and the status filter compose with AND.
- Apply status filtering to seed tasks before closure expansion, so non-matching related tasks may still appear as graph context.
- Fail loudly with a tagged validation error for invalid status values.
- Cover the behavior through CLI/engine tests that prove OR status matching and filter-before-closure context.

## Done when

- `pithos graph inspect --all --status queued` returns a graph seeded by queued tasks plus their closure context.
- `pithos graph inspect --scope repo:fe --status claimed --status running` seeds from claimed or running tasks in that scope.
- Invalid status input fails rather than being ignored.
- Relevant Pithos CLI and graph tests pass.

## Out of scope

- Search filtering.
- Time filtering.
- Ready/blocked derived filters.
- Agent/capability/claimability filters.
- Post-closure node hiding.

## References

- `specs/pithos-graph-inspection.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
