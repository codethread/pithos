# Task 3: Graph search seed filter

## Scope

Type: AFK

Add repeatable text search to `pithos graph inspect` for recall-driven task discovery. Search filters seed tasks by case-insensitive substring matches against task title and body only, then graph closure supplies context.

## Must implement exactly

- Add repeatable `--search <text>` to `pithos graph inspect`.
- Reject empty search terms with a tagged validation error.
- Match each search term case-insensitively against task `title` or task `body`.
- Repeated `--search` values compose with AND: every term must match the seed task's searchable text.
- Compose search with selector and status filters using AND.
- Apply search filtering to seed tasks before closure expansion, so related context tasks may appear even when they do not match the search terms.
- Do not search artifacts, events, runs, scopes, paths, transcripts, or supervisor logs.
- Cover the behavior through CLI/engine tests that prove repeated-search AND semantics and filter-before-closure context.

## Done when

- `pithos graph inspect --all --search auth` seeds graph context from tasks whose title or body mentions `auth`, case-insensitively.
- `pithos graph inspect --all --search auth --search token` only seeds from tasks matching both terms.
- Search composes correctly with `--status`.
- Empty search terms fail loudly.
- Relevant Pithos CLI and graph tests pass.

## Out of scope

- Full-text search indexes or ranking.
- OR search/grouping syntax.
- Artifact, event, scope, path, transcript, or log search.
- New task-list or task-search commands.

## References

- `specs/pithos-graph-inspection.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
