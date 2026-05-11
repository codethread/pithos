# Task 021: Pdx machine-readable help for Pandora

## Scope

Type: AFK

Add a machine-readable pdx help surface for agent prompt injection while keeping the default human-facing `pdx --help` output unchanged.

Pdx remains the local supervisor and is primarily human/operator-facing, but Pandora needs structured command cards for inspection workflows such as daemon status, daemon logs, and run transcripts.

## Must implement exactly

- Add a pdx JSON help path without changing default `pdx --help` text rendering.
- Prefer an explicit flag such as `pdx --help-json`; fail loudly if the chosen surface cannot be parsed unambiguously before Effect CLI handles built-in help.
- Generate the JSON help from the existing Effect command descriptor tree, not from a separate hand-maintained command list.
- Include at least: tool name, command name, full path, usage, description, and nested subcommands.
- Preserve pdx domain language: pdx owns local supervision, daemon state, tmux/process lifecycle, logs, transcripts, and kill policy; Pithos owns durable state.
- Ensure the JSON includes Pandora-relevant commands: `pdx daemon status`, `pdx daemon logs`, and `pdx run transcript`.
- Add tests or command-level coverage that validates JSON parseability and at least one nested pdx command path.
- Keep normal pdx command parsing/execution behavior unchanged for all non-JSON-help invocations.

## Done when

- `pdx --help` still renders human text.
- `pdx --help-json | jq .` succeeds.
- The JSON contains `pdx daemon status`, `pdx daemon logs`, and `pdx run transcript` command paths.
- Relevant pdx tests pass.

## Out of scope

- Making pdx default help JSON.
- Pithos default help changes.
- Spawner prompt/template injection.
- Role-specific filtering.
- Rich structured option/argument docs beyond the usage string.

## References

- `packages/pdx/src/main.ts`
- `packages/pdx/test/substrate.test.ts`
- `packages/pdx/README.md`
- `specs/control-plane-supervision.md`
- `UBIQUITOUS_LANGUAGE.md`
