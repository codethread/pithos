# Task 017: Artifact add stdin body

## Scope

Type: AFK

Implement the `pithos task artifact add --stdin` contract end to end for artifact bodies.

Artifact creation through the CLI must require meaningful body content from stdin and must no longer create empty artifacts by omission.

## Must implement exactly

- Change `task artifact add` CLI shape to require `--stdin` for the artifact body payload.
- Remove artifact add `--body-file` from the public CLI command definition.
- Read stdin through the existing typed input service boundary; do not read raw process stdin in command/domain logic.
- When artifact add is invoked without `--stdin`, return tagged JSON error with code `VALIDATION_ERROR`, not raw parser usage output.
- When `--stdin` is present but no redirected stdin is available, return tagged JSON error with code `VALIDATION_ERROR`.
- When decoded stdin length is `0`, return tagged JSON error with code `VALIDATION_ERROR`; do not trim before checking.
- When stdin read itself fails, fail loudly as tagged `PithosError` through the CLI/service boundary.
- Preserve existing non-payload artifact behavior: `--task`, optional `--run`, `--kind`, `--title`, and `PITHOS_RUN_ID` resolution.
- Revise the engine-facing artifact add input so the CLI passes explicit resolved body text rather than file-path indirection.
- Add or update behavior tests proving artifact body persistence from stdin and rejection of omitted/empty payloads.
- Update the artifact add command-contract text in normative specs touched by this change so the repository does not describe optional empty artifacts or removed payload flags as current behavior after this slice lands.

## Done when

- `pithos task artifact add --task <id> --kind <kind> --title <title> --stdin` stores the stdin body.
- Artifact add without `--stdin` emits tagged validation JSON and exits with the validation exit code.
- `--body-file` is no longer accepted for artifact add.
- Relevant pithos tests pass.

## Out of scope

- Enqueue, supersede, and complete behavior beyond preserving already-passing contracts.
- README, demo, and agent prompt updates not required to keep normative command contracts consistent for artifact add.
- DB schema changes.
- Adding metadata-only empty artifacts.

## References

- `specs/pithos-stdin-payload-api-change.md`
- `specs/control-plane-supervision.md`
- `packages/pithos/src/cli.ts`
- `packages/pithos/src/engine.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
- `packages/pithos/test/cli.test.ts`
