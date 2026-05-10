# Task 018: Complete stdin result metadata

## Scope

Type: AFK

Implement the `pithos task complete <task-id> --token <n> [--stdin]` contract end to end for optional machine-readable completion metadata.

Completion without `--stdin` must preserve the current default `{}` result and must not read stdin. Completion with `--stdin` must read one stdin document and persist it only when it parses as a JSON object.

## Must implement exactly

- Change `task complete` CLI shape to expose optional `--stdin` and remove `--result-file` from the public CLI command definition.
- Without `--stdin`, do not call the stdin/input service and complete with `result_json` equal to `{}`.
- With `--stdin`, read stdin exactly once through the typed input service boundary.
- With `--stdin`, fail with tagged `VALIDATION_ERROR` JSON when no redirected stdin is available or decoded stdin length is `0`.
- With `--stdin`, parse the decoded text as JSON and require the parsed value to be a JSON object.
- Reject invalid JSON, arrays, strings, numbers, booleans, and null with tagged `VALIDATION_ERROR` JSON.
- Revise the engine-facing complete input so the CLI passes explicit resolved result metadata rather than file-path indirection.
- Preserve existing non-payload completion behavior: task id arg, optional `--run`, `--token`, fencing semantics, and `PITHOS_RUN_ID` resolution.
- Add or update behavior tests covering no-stdin default, valid object stdin, empty stdin, invalid JSON, and valid non-object JSON.
- Update the complete command-contract text in normative specs touched by this change so the repository does not describe `--result-file` as current behavior after this slice lands.

## Done when

- `pithos task complete <task-id> --run <run-id> --token <n>` completes with `{}` result metadata and never reads stdin.
- `printf '%s' '{"ok":true}' | pithos task complete <task-id> --run <run-id> --token <n> --stdin` stores the JSON object as result metadata.
- `--result-file` is no longer accepted for complete.
- Relevant pithos tests pass.

## Out of scope

- Long-form human-facing work products; those belong in artifacts.
- Enqueue, supersede, and artifact add behavior beyond preserving already-passing contracts.
- README, demo, and agent prompt updates not required to keep normative command contracts consistent for complete.
- DB schema changes.

## References

- `specs/pithos-stdin-payload-api-change.md`
- `specs/control-plane-supervision.md`
- `specs/control-plane-design-notes.md`
- `UBIQUITOUS_LANGUAGE.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
- `packages/pithos/test/cli.test.ts`
