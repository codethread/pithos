# Task 020: Pithos JSON help surface

## Scope

Type: AFK

Replace the default `pithos --help` output with a machine-readable JSON command tree generated from the Effect CLI command descriptor.

The JSON help surface is agent-facing command documentation. It must preserve Pithos domain language, fix the misleading flattened nested command listing, and provide enough structure for downstream prompt filtering.

## Must implement exactly

- Add a Pithos help renderer that walks the existing Effect `Command` descriptor tree and emits JSON.
- Unwrap Effect descriptor `Map` nodes and preserve real nested command paths such as `pithos task artifact add`.
- Include at least: tool name, command name, full path, usage, description, and nested subcommands.
- Use existing Effect metadata as the source of truth for usage and descriptions; do not duplicate command descriptions in a separate hand-maintained tree.
- Make `pithos --help` and `pithos -h` print the JSON help surface by default.
- Keep normal command parsing/execution behavior unchanged for every non-help invocation.
- Ensure the JSON is stable enough for agents and tests: deterministic ordering, valid JSON, no ANSI escapes.
- Add or update tests covering top-level help JSON and the nested artifact command path.
- Remove or update notes that treat `task task artifact add` as acceptable generated help output.

## Done when

- `pithos --help | jq .` succeeds.
- The JSON contains `pithos task artifact add` exactly once as a nested command path and does not contain `task task artifact add`.
- Existing Pithos CLI behavior tests pass.

## Out of scope

- Pdx help behavior.
- Spawner prompt/template injection.
- Role-specific filtering.
- Rich structured option/argument docs beyond the usage string.
- Replacing Effect CLI parsing or command execution.

## References

- `packages/pithos/src/main.ts`
- `packages/pithos/src/cli.ts`
- `packages/pithos/test/cli.test.ts`
- `tasks/README.md`
- `UBIQUITOUS_LANGUAGE.md`
