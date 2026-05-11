# Task 024: Enqueue chain flag baseline

## Scope

Type: AFK

Add the public `pithos task enqueue --chain auto|none|held|source` flag and thread the selected chain policy through the CLI and engine using the pure chain-policy core.

This is the tracer bullet for the automatic chaining API: callers can pass the flag, output reports the selected chain policy, and `--chain none` creates intentionally flat/manual-only tasks.

## Must implement exactly

- Add a typed chain policy with allowed values `auto`, `none`, `held`, and `source` at the CLI boundary.
- Default omitted `--chain` to `auto`.
- Thread the chain policy into the engine enqueue input.
- Call the pure chain-policy resolver from the enqueue path, even though this slice should only exercise no-held/none behavior end-to-end.
- Preserve existing explicit `--depends-on` behavior and validation.
- For this slice, `auto` with no held task and `none` both add no implicit dependency and no source link.
- Include a `chain` object in successful enqueue JSON and `task.created` payloads with at least policy, applied decision, held task id when available, source task id when available, and final dependency ids.
- Ensure `--chain none --depends-on <task-id>` is manual-only: no implicit relationship is added beyond the named dependency.
- Validate invalid `--chain` values as tagged validation errors through the existing CLI error path.
- Add or update CLI/engine tests for flag parsing, defaulting, `none`, invalid mode, and enqueue output shape.
- Keep detailed graph decision tests in the pure test suite from task 023; this slice only needs DB/CLI contract tests for the threaded behavior.

## Done when

- `pithos task enqueue` accepts `--chain auto|none|held|source` and defaults to `auto`.
- Existing enqueue tests still pass with the new response contract updated intentionally.
- New tests prove `--chain none` preserves manual dependencies and creates no implicit relationship.
- `task.created` events include deterministic chain metadata.

## Out of scope

- Adding `task_sources` storage.
- Creating implicit dependencies from held tasks.
- Implementing DB-backed `held` / `source` behavior beyond parsing, pure resolver integration, and current no-held validation where applicable.
- Updating agent templates.

## References

- `specs/task-graph.md`
- `UBIQUITOUS_LANGUAGE.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/cli.test.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
