#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' \
  'scripts/pandora-start.sh is intentionally unavailable after slice 4.' \
  'Launcher preview lives at `pandora-spawn preview ...` and interactive startup moves to `pdx open` in slice 5.' \
  'For prompt-render validation, initialize the next DB first:' \
  '  pithos-next init --fresh' \
  '  PITHOS_BIN=pithos-next pandora-spawn preview --agent pandora --mode hitl --scope global --run run_PREVIEW --session-id session_PREVIEW --cwd ~/.pandora' \
  >&2
exit 1
