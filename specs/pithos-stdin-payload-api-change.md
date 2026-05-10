# Change Spec: Pithos stdin payload API

**Status:** Pending
**Last Updated:** 2026-05-10
**Type:** Change spec
**Scope:** `packages/pithos/src/cli.ts`, `packages/pithos/src/engine.ts`, downstream agent prompts/docs

## Summary

Unify Pithos payload-bearing CLI commands around a single rule: if a command accepts a document payload, that payload comes from stdin, never from `--body`, `--body-file`, or `--result-file` flags.

This change is intentionally CLI-surface only. It does not change task/run/artifact DB semantics except where noted below for stricter payload requirements.

## Why this change

Current payload APIs are inconsistent:

- `task enqueue` supports `--body` or `--body-file`
- `task supersede` supports `--body` or `--body-file`
- `task artifact add` supports `--body-file` only
- `task complete` supports `--result-file` only

That inconsistency pushes agents toward scratch files in `.tmp/` just to attach multiline content safely. The command surface also mixes two different ideas for the same field: inline flags for some commands, file indirection for others.

Desired design language:

- routing and identity stay in flags/args
- document payloads come from stdin
- one command may consume at most one stdin payload
- if a workflow ever needs two independent payloads, it should be split into two commands rather than inventing multi-payload stdin conventions

## Goals

- Remove payload/file flag variants from the public `pithos` CLI
- Make stdin the only transport for task body, replacement body, artifact body, and completion result payloads
- Eliminate the need for temp files when agents attach artifacts or enqueue rich task bodies
- Keep failure modes loud and deterministic

## Non-goals

- No backward-compatibility shim for `--body`, `--body-file`, or `--result-file`
- No DB schema change
- No new compound command that both adds an artifact and completes a task in one step
- No change to non-payload flags such as `--run`, `--scope`, `--capability`, `--reason`, or `--token`

## Decisions

- **Decision:** stdin becomes the only payload channel for payload-bearing task mutations.
  - **Rationale:** This gives every payload-bearing command the same mental model and removes the agent need to materialize content into temp files just to pass it back into the CLI.

- **Decision:** `task supersede` must receive a replacement body on stdin.
  - **Rationale:** Supersede creates a new task. Requiring an explicit new body makes that replacement instruction snapshot intentional rather than silently inheriting stale text from the old task.

- **Decision:** `task artifact add` must receive an artifact body on stdin.
  - **Rationale:** Empty artifacts are weak evidence and usually accidental. If an artifact is worth recording, it should carry content.

- **Decision:** `task complete` may omit stdin and continue to default `result_json` to `{}`.
  - **Rationale:** The durable human-facing work product should live in artifacts. Completion result payloads are secondary machine-facing metadata, so "mark done without extra result payload" remains a valid operation.

- **Decision:** No command will accept more than one stdin document.
  - **Rationale:** Once multiple payload slots exist, stdin becomes ambiguous. Multi-document workflows should be modeled as multiple commands.

## Proposed CLI contract

### `pithos task enqueue`

New shape:

```sh
pithos task enqueue \
  --scope <scope-id> \
  --capability <triage|design|execute|escalate> \
  --title <text> \
  [--run <run-id>] \
  [--depends-on <task-id> ...] \
  < stdin
```

Rules:

- stdin is required
- stdin must decode to a non-empty body string
- `--body` and `--body-file` are removed
- `PITHOS_RUN_ID` resolution stays unchanged

### `pithos task supersede`

New shape:

```sh
pithos task supersede \
  <task-id> \
  --run <run-id> \
  --reason <text> \
  [--title <text>] \
  [--scope <scope-id>] \
  [--capability <triage|design|execute|escalate>] \
  < stdin
```

Rules:

- stdin is required
- stdin becomes the replacement task body
- old body inheritance is removed
- `--body` and `--body-file` are removed
- title/scope/capability overrides remain optional flags

### `pithos task artifact add`

New shape:

```sh
pithos task artifact add \
  --task <task-id> \
  --run <run-id> \
  --kind <kind> \
  --title <text> \
  < stdin
```

Rules:

- stdin is required
- stdin must decode to a non-empty artifact body string
- `--body-file` is removed
- creating empty-body artifacts is no longer allowed

### `pithos task complete`

New shape:

```sh
pithos task complete <task-id> --run <run-id> --token <n> [< stdin]
```

Rules:

- stdin is optional
- when stdin is absent, `result_json` remains `{}`
- when stdin is present, its text becomes `result_json`
- `--result-file` is removed
- this change does not itself require stronger JSON validation than current behavior

## stdin behavior contract

Commands with required stdin (`enqueue`, `supersede`, `artifact add`) must:

- fail with `VALIDATION_ERROR` when stdin is not redirected/piped
- fail with `VALIDATION_ERROR` when stdin resolves to an empty string
- read stdin exactly once

Commands with optional stdin (`complete`) must:

- treat non-redirected stdin as "no payload supplied"
- default to `{}` only in that no-stdin case
- fail with `VALIDATION_ERROR` if stdin is redirected/piped but resolves to an empty string

## Examples

Enqueue:

```sh
printf '%s\n' '# Triage\n\nInvestigate the failing run.' | \
  pithos task enqueue --scope global --capability triage --title 'investigate failure' --run run_pandora
```

Supersede:

```sh
printf '%s\n' '# Replacement task\n\nUse the repaired scope and new plan.' | \
  pithos task supersede task_old --run run_toil --reason repair --title 'repaired task'
```

Artifact add:

```sh
printf '%s\n' '# Execution notes\n\nPatched file X and verified test Y.' | \
  pithos task artifact add --task task_123 --run run_war --kind war-completion --title 'implementation notes'
```

Complete without extra result payload:

```sh
pithos task complete task_123 --run run_war --token 1
```

Complete with explicit result payload:

```sh
printf '%s\n' '{"verified":true,"tests":["substrate.test.ts"]}' | \
  pithos task complete task_123 --run run_war --token 1
```

## Expected downstream changes when implemented

- Agent prompts can stop instructing temp-file artifact staging
- CLI tests must be rewritten around stdin-fed payloads
- Docs and demos must replace `--body`, `--body-file`, and `--result-file` examples
- Any wrapper or harness helper currently materializing temp files for payload submission can be simplified

## Explicitly rejected alternatives

- Keep `--body` for short strings and add stdin as another option
  - Rejected because it preserves two API dialects for the same field

- Support `--body-file -` as stdin sentinel
  - Rejected because it keeps file-oriented naming around a non-file API

- Preserve inherited supersede bodies when stdin is omitted
  - Rejected because replacement tasks should carry an explicit new instruction snapshot

- Allow empty artifacts as metadata-only markers
  - Rejected because the durable artifact surface should bias toward meaningful content

## Implementation note for later

This spec is a pending API change proposal only. It should not be treated as implemented behavior until the CLI, tests, docs, and prompts are updated together.
