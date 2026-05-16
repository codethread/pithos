# Task 4: Graph since seed filter

## Scope

Type: AFK

Add `--since <cutoff>` to `pithos graph inspect` so operators can inspect recently touched tasks with graph context. The filter uses task lifecycle timestamps only and applies to seed tasks before closure expansion.

## Must implement exactly

- Add optional `--since <cutoff>` to `pithos graph inspect`.
- Support exactly these cutoff forms:
  - `today`
  - `<n>h`
  - `<n>d`
  - `YYYY-MM-DD`
  - ISO timestamp with timezone
- Interpret `today` and `YYYY-MM-DD` as local operator-day cutoffs.
- Interpret relative forms from the injected Pithos clock, not arbitrary direct process time in domain logic.
- Select seed tasks where `created_at`, `updated_at`, or `completed_at` is at or after the parsed cutoff.
- Compose `--since` with selector, status, and search filters using AND.
- Apply the filter before graph closure expansion.
- Fail loudly with a tagged validation error for invalid cutoff forms.
- Cover supported cutoff forms, invalid cutoff failure, and filter-before-closure context in tests.

## Done when

- `pithos graph inspect --all --since today` seeds from tasks touched today plus graph context.
- `pithos graph inspect --scope repo:fe --since 24h` seeds from tasks in that scope touched within the last 24 hours plus graph context.
- `--since` composes correctly with `--status` and `--search`.
- Invalid cutoff input fails loudly.
- Relevant Pithos CLI and graph tests pass.

## Out of scope

- `--until` or historical state reconstruction.
- Artifact/event/run/transcript activity as part of “touched”.
- Natural-language date parsing beyond the specified forms.
- Timezone configuration options.

## References

- `specs/pithos-graph-inspection.md`
- `packages/pithos/src/services.ts`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
