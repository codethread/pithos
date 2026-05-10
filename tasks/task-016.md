# Task 016: Supersede stdin replacement body

## Scope

Type: AFK

Implement the `pithos task supersede ... --stdin` contract end to end for replacement task bodies.

The command must always receive an explicit replacement body from stdin and must no longer inherit the old task body when the caller omits payload input.

## Must implement exactly

- Change `task supersede` CLI shape to require explicit `--stdin` for the replacement body payload.
- Remove supersede `--body` and `--body-file` from the public CLI command definition.
- Read stdin through the service boundary introduced for payload input; do not read raw process stdin in command/domain logic.
- When supersede is invoked without `--stdin`, return tagged JSON error with code `VALIDATION_ERROR`, not raw parser usage output.
- When `--stdin` is present but no redirected stdin is available, return tagged JSON error with code `VALIDATION_ERROR`.
- When decoded stdin length is `0`, return tagged JSON error with code `VALIDATION_ERROR`; do not trim before checking.
- When stdin read itself fails, fail loudly as tagged `PithosError` through the CLI/service boundary.
- Preserve existing non-payload supersede behavior: task id arg, optional `--run`, `--reason`, optional `--title`, optional `--scope`, optional `--capability`, and `PITHOS_RUN_ID` resolution.
- Add or update behavior tests proving the new task receives the stdin body and no old-body inheritance remains available through the CLI.
- Update the supersede command-contract text in normative specs touched by this change so the repository does not describe supersede body inheritance or removed payload flags as current behavior after this slice lands.

## Done when

- `pithos task supersede <task-id> --reason <text> --stdin` creates a replacement task with the stdin body.
- Supersede without `--stdin` emits tagged validation JSON and exits with the validation exit code.
- `--body` and `--body-file` are no longer accepted for supersede.
- Relevant pithos tests pass.

## Out of scope

- Enqueue, artifact add, and complete behavior beyond preserving already-passing contracts.
- README, demo, and agent prompt updates not required to keep normative command contracts consistent for supersede.
- DB schema changes.
- Introducing body inheritance under another flag or fallback.

## References

- `specs/pithos-stdin-payload-api-change.md`
- `specs/control-plane-supervision.md`
- `specs/task-graph.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
- `packages/pithos/test/cli.test.ts`
