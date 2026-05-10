# Task 015: Enqueue stdin payload CLI slice

## Scope

Type: AFK

Implement the `pithos task enqueue --stdin` contract end to end through the CLI boundary for task body payloads.

This slice should introduce the typed stdin/input service boundary needed by later payload commands, then use it for enqueue only. The CLI must read stdin exactly when `--stdin` is present, pass the resolved body string to the existing engine boundary, and stop exposing enqueue body/file payload flags.

## Must implement exactly

- Add a typed service boundary for stdin/input state in `@pithos/pithos` services, with live and test-friendly implementations.
- Support the minimum states from `specs/pithos-stdin-payload-api-change.md`: no redirected stdin available, redirected text read, and read failure.
- Change `task enqueue` CLI shape to require `--stdin` for the body payload.
- Remove enqueue `--body` and `--body-file` from the public CLI command definition.
- When enqueue is invoked without `--stdin`, return tagged JSON error with code `VALIDATION_ERROR`, not raw parser usage output.
- When `--stdin` is present but no redirected stdin is available, return tagged JSON error with code `VALIDATION_ERROR`.
- When decoded stdin length is `0`, return tagged JSON error with code `VALIDATION_ERROR`; do not trim before checking.
- When stdin read itself fails, fail loudly as a tagged `PithosError` through the CLI/service boundary.
- Preserve existing non-payload enqueue behavior: `--scope`, `--capability`, `--title`, optional `--run`, repeated `--depends-on`, and `PITHOS_RUN_ID` resolution.
- Add or update behavior tests at stable public boundaries for successful enqueue via stdin and the required failure cases above.
- Update the enqueue command-contract text in normative specs touched by this change so the repository does not describe the removed enqueue payload flags as current behavior after this slice lands.

## Done when

- `pithos task enqueue ... --stdin` can create a task with a multiline stdin body.
- `pithos task enqueue` without `--stdin` emits JSON `{ ok: false, error: { code: "VALIDATION_ERROR", ... } }` and exits with the validation exit code.
- `--body` and `--body-file` are no longer accepted for enqueue.
- Relevant pithos tests pass.

## Out of scope

- Supersede, artifact add, and complete stdin behavior.
- README, demo, and agent prompt updates not required to keep normative command contracts consistent for enqueue.
- DB schema changes.
- Changing the typed engine API to consume streams directly.

## References

- `specs/pithos-stdin-payload-api-change.md`
- `specs/control-plane-supervision.md`
- `specs/task-graph.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/services.ts`
- `packages/pithos/test/cli.test.ts`
