#!/usr/bin/env bash
set -euo pipefail

[ -n "${PITHOS_AGENT:-}" ] || exit 0
[ -n "${PITHOS_RUN_ID:-}" ] || exit 0
[ -n "${PITHOS_BIN:-}" ] || {
  printf '%s\n' 'pandora-spawn dispatch.sh: missing PITHOS_BIN' >&2
  exit 1
}

case "${1:-}" in
  PreToolUse)
    "$PITHOS_BIN" task heartbeat --run "$PITHOS_RUN_ID"
    ;;
  SessionEnd)
    # `pdx` owns run finalization. Session-end hooks are observation only.
    exit 0
    ;;
  *)
    printf '%s\n' "pandora-spawn dispatch.sh: unknown hook event ${1:-<empty>}" >&2
    exit 1
    ;;
esac
