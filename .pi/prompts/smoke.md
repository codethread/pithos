# Smoke — slice 4 spawner preview

Validate the launcher-only refactor without relying on removed control-plane commands.

## Goal

Confirm that:

- `pithos-next init --fresh` seeds the capability matrix
- `pandora-spawn preview` renders valid JSON for `pandora`, `toil`, `greed`, and `war`
- rendered prompts use the current `triage | design | execute | escalate` model
- prompts contain the correct self-claim command with `PITHOS_BIN=pithos-next`
- mode mismatch fails loudly with structured JSON

## Procedure

From the repo root:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm run build
```

Initialize fresh state for preview validation:

```sh
packages/pithos/bin/pithos-next init --fresh
```

Render each spawnable agent:

```sh
PITHOS_BIN=pithos-next pandora-spawn preview --agent pandora --mode hitl --scope global --run run_PREVIEW --session-id session_PREVIEW --cwd ~/.pandora | jq .
PITHOS_BIN=pithos-next pandora-spawn preview --agent toil --mode afk --scope repo:dev/pithos --run run_PREVIEW --session-id session_PREVIEW --cwd "$PWD" | jq .
PITHOS_BIN=pithos-next pandora-spawn preview --agent greed --mode hitl --scope global --run run_PREVIEW --session-id session_PREVIEW --cwd ~/.pandora | jq .
PITHOS_BIN=pithos-next pandora-spawn preview --agent war --mode afk --scope repo:dev/pithos --run run_PREVIEW --session-id session_PREVIEW --cwd "$PWD" | jq .
```

Mode mismatch should fail with a structured validation error:

```sh
PITHOS_BIN=pithos-next pandora-spawn preview --agent war --mode hitl --scope repo:dev/pithos --run run_PREVIEW --session-id session_PREVIEW --cwd "$PWD"
```

## Expected observations

- `pandora` claims `escalate`
- `toil` claims `triage`
- `greed` claims `design`
- `war` claims `execute`
- rendered prompts do not mention Envy, workers, or `implement`
- the output JSON includes `agent`, `mode`, `runId`, `sessionId`, `scopeId`, `cwd`, `logicalName`, `harness`, and `prompt`
- mode mismatch exits non-zero with `{"ok":false,"error":{"code":"VALIDATION_ERROR",...}}`

## Notes

- `scripts/pandora-start.sh` is intentionally unavailable after slice 4.
- Interactive startup moves to `pdx open` in slice 5.
- Do not use removed `pandora-spawn` surfaces like `status`, `nudge`, or `kill` in this smoke.
