# Task 013b: Spawner public API, manifest tuning, and transcript parser

## Status

Complete in current working tree. Re-run full verification before commit.

## Scope

Make `@pithos/spawner` the real package-root API for rendering, launching rendered plans, and parsing harness transcripts.

## Acceptance

- `@pithos/spawner` package root exports source APIs and consumers do not import sibling `src/*` internals.
- Public API includes `renderAgent`, `launchRenderedAgent`, `launchAgent`, `renderSessionTranscript`, public service interfaces, and intended live implementation.
- `RenderedAgent` includes `sessionLogPath`; `LaunchResult` reports runtime launch metadata and does not duplicate rendered argv/env.
- `launchAgent(input)` remains a convenience wrapper; pdx can render once, persist metadata, then `launchRenderedAgent(rendered)`.
- Manifest supports required `model`, required `system_prompt_mode`, optional non-empty `tools`, and optional unique basename `includes`.
- Tool names pass through unvalidated; argv rendering is `--model`, `--tools <csv>`, and `--system-prompt`/`--append-system-prompt`.
- Include files are raw text, not recursively rendered; unknown template vars fail loudly.
- All caller-supplied `sessionId` values are UUID-validated.
- Preview/render keeps strong DB context requirements and emits a clear error when neither `PITHOS_DB` nor `PDX_DATA_DIR` is available.
- Transcript parsing accepts explicit `{ harnessKind, sessionLogPath, limit? }`, defaults limit to 20, emits plain text transcript lines, and fails loudly on missing/corrupt logs.
- Spawner README/help/tests reflect the new public API and manifest shape.
