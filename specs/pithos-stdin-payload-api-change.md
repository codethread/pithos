# Change Spec: Pithos stdin payload API

**Status:** Implemented
**Last Updated:** 2026-05-10
**Type:** Change spec
**Scope:** public `pithos` CLI contract, `packages/pithos/src/cli.ts`, `packages/pithos/src/services.ts`, live/test stdin service implementations, downstream agent prompts/docs

## Summary

Unify Pithos payload-bearing CLI commands around a single rule: payload text is supplied through stdin only when the caller explicitly opts in with `--stdin`. The CLI stops accepting `--body`, `--body-file`, and `--result-file`.

This is the implemented public CLI surface. It does not require the typed in-process engine API to adopt stdin semantics: the CLI resolves stdin into explicit strings at the boundary before calling engine functions.

## Relationship to current specs

The implemented command contract is shared with:

- `specs/control-plane-supervision.md`
- `specs/task-graph.md`

Those specs remain normative for supervision and graph semantics; this document is the focused stdin payload contract.

## Why this change

The previous payload APIs were inconsistent and pushed agents toward scratch files for multiline content. The current command surface gives every payload-bearing task mutation one explicit stdin contract:

- routing and identity stay in flags/args
- document payloads come from stdin
- stdin is only consumed when `--stdin` is explicitly present
- one command may consume at most one stdin payload

## Goals

- Remove payload/file flag variants from the public `pithos` CLI
- Make stdin the only transport for task body, replacement body, artifact body, and optional completion result payloads
- Eliminate the need for temp files when agents attach artifacts or enqueue rich task bodies
- Ensure commands never accidentally block on stdin when the caller did not request stdin consumption
- Keep failure modes loud and deterministic

## Non-goals

- No backward-compatibility shim for `--body`, `--body-file`, or `--result-file`
- No DB schema change
- No new compound command that both adds an artifact and completes a task in one step
- No change to non-payload flags such as `--run`, `--scope`, `--capability`, `--reason`, or `--token`
- No requirement that the typed engine API itself consume stdin directly

## Decisions

- **Decision:** stdin is the only payload channel for payload-bearing task mutations, and stdin is consumed only when `--stdin` is present.
  - **Rationale:** This gives every payload-bearing command one explicit mental model while avoiding accidental hangs or implicit stdin reads in headless environments.

- **Decision:** `task supersede` must receive a replacement body via `--stdin`.
  - **Rationale:** Supersede creates a new task. Requiring an explicit new body makes that replacement instruction snapshot intentional rather than silently inheriting stale text from the old task.

- **Decision:** `task artifact add` must receive an artifact body via `--stdin`.
  - **Rationale:** Empty artifacts are weak evidence and usually accidental. If an artifact is worth recording, it should carry content.

- **Decision:** `task complete` may omit `--stdin` and continue to default `result_json` to `{}`, but when `--stdin` is used it must decode to a valid JSON object.
  - **Rationale:** The durable human-facing work product should live in artifacts. Completion result payloads are secondary machine-facing metadata, but they still cross an IO boundary into durable DB state and should remain machine-readable.

- **Decision:** No command will accept more than one stdin document.
  - **Rationale:** Once multiple payload slots exist, stdin becomes ambiguous. Multi-document workflows should be modeled as multiple commands.

- **Decision:** This change is a CLI contract change, not necessarily an engine contract change.
  - **Rationale:** Downstream in-process callers already pass explicit strings to engine functions. The CLI can adopt stdin without forcing those call sites onto a stream-based API.

## CLI contract

For all commands below, `--run` behavior remains unchanged: it stays optional at the CLI layer where `PITHOS_RUN_ID` currently applies.

### `pithos task enqueue`

Shape:

```sh
pithos task enqueue \
  --scope <scope-id> \
  --capability <triage|design|execute|escalate> \
  --title <text> \
  --stdin \
  [--run <run-id>] \
  [--depends-on <task-id> ...]
```

Rules:

- `--stdin` is required
- stdin must decode to a non-empty body string
- `--body` and `--body-file` are removed
- `PITHOS_RUN_ID` resolution stays unchanged

### `pithos task supersede`

Shape:

```sh
pithos task supersede \
  <task-id> \
  [--run <run-id>] \
  --reason <text> \
  [--title <text>] \
  [--scope <scope-id>] \
  [--capability <triage|design|execute|escalate>] \
  --stdin
```

Rules:

- `--stdin` is required
- stdin becomes the replacement task body
- old body inheritance is removed
- `--body` and `--body-file` are removed
- title/scope/capability overrides remain optional flags
- `PITHOS_RUN_ID` resolution stays unchanged

### `pithos task artifact add`

Shape:

```sh
pithos task artifact add \
  --task <task-id> \
  [--run <run-id>] \
  --kind <kind> \
  --title <text> \
  --stdin
```

Rules:

- `--stdin` is required
- stdin must decode to a non-empty artifact body string
- `--body-file` is removed
- creating empty-body artifacts is no longer allowed
- `PITHOS_RUN_ID` resolution stays unchanged

### `pithos task complete`

Shape:

```sh
pithos task complete <task-id> [--run <run-id>] --token <n> [--stdin]
```

Rules:

- `--stdin` is optional
- without `--stdin`, the command must not read stdin and `result_json` remains `{}`
- with `--stdin`, stdin must decode to a valid JSON object and that object becomes `result_json`
- `--result-file` is removed
- `PITHOS_RUN_ID` resolution stays unchanged
- `--run` may be omitted only when `PITHOS_RUN_ID` resolves it; otherwise fail loudly

## stdin behavior contract

stdin handling must be introduced through the existing service boundary, not through ad hoc direct reads in domain logic. The CLI boundary should read stdin once through a typed input service and then pass explicit values onward.

Minimum service-level states are:

- interactive / no redirected stdin available
- redirected text stdin successfully read
- stdin read failure

Command behavior:

- commands with required payloads (`enqueue`, `supersede`, `artifact add`) must require `--stdin`
- if a required-payload command is invoked without `--stdin`, the CLI boundary must normalize that to tagged `VALIDATION_ERROR` JSON rather than raw parser usage output
- if `--stdin` is present for a required-payload command but no redirected stdin is available, it fails with `VALIDATION_ERROR`
- if `--stdin` is present and decoded stdin length is `0`, it fails with tagged `VALIDATION_ERROR`
- decoded stdin emptiness is checked by string length only; no trimming is applied
- `task complete` without `--stdin` never reads stdin and always uses `{}`
- `task complete --stdin` reads stdin exactly once, parses the decoded text as JSON, and requires the parsed value to be a JSON object
- `task complete --stdin` fails with tagged `VALIDATION_ERROR` when no redirected stdin is available
- `task complete --stdin` fails with tagged `VALIDATION_ERROR` when decoded stdin length is `0`
- `task complete --stdin` fails with tagged `VALIDATION_ERROR` when stdin is not valid JSON or is valid JSON but not an object
- stdin read failures map to tagged `PithosError` values through the CLI/service boundary

## Result payload note

`task complete --stdin` is for machine-readable completion metadata, not the human-facing work product. The stdin payload must parse as a JSON object. Long-form narrative output belongs in task artifacts.

Representative shapes:

```json
{ "ok": true }
```

```json
{
	"ok": true,
	"summary": "implemented fix and verified substrate test",
	"artifacts": ["artifact_123"],
	"checks": [{ "name": "substrate.test.ts", "ok": true }]
}
```

Implementation note: Effect's schema pretty-print support can help render these example payloads into help text. Use a typed schema plus `Pretty.make(schema)` rather than hand-formatting example JSON strings.

## Examples

Enqueue:

```sh
printf '%s\n' '# Triage\n\nInvestigate the failing run.' | \
  pithos task enqueue --scope global --capability triage --title 'investigate failure' --stdin --run run_pandora
```

Supersede:

```sh
printf '%s\n' '# Replacement task\n\nUse the repaired scope and new plan.' | \
  pithos task supersede task_old --run run_toil --reason repair --title 'repaired task' --stdin
```

Artifact add:

```sh
printf '%s\n' '# Execution notes\n\nPatched file X and verified test Y.' | \
  pithos task artifact add --task task_123 --run run_war --kind war-completion --title 'implementation notes' --stdin
```

Complete without extra result payload:

```sh
pithos task complete task_123 --run run_war --token 1
```

Complete with explicit result payload:

```sh
printf '%s\n' '{"verified":true,"tests":["substrate.test.ts"]}' | \
  pithos task complete task_123 --run run_war --token 1 --stdin
```

## Explicitly rejected alternatives

- Keep `--body` for short strings and add stdin as another option
  - Rejected because it preserves two API dialects for the same field

- Support `--body-file -` or `--result-file -` as stdin sentinel
  - Rejected because it keeps file-oriented naming around a non-file API

- Read stdin implicitly whenever a payload-bearing command sees redirected input
  - Rejected because explicit `--stdin` is safer in headless and automated invocation contexts

- Preserve inherited supersede bodies when stdin is omitted
  - Rejected because replacement tasks should carry an explicit new instruction snapshot

- Allow empty artifacts as metadata-only markers
  - Rejected because the durable artifact surface should bias toward meaningful content
