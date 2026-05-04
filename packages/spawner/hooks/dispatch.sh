#!/usr/bin/env bash
[ -n "${PITHOS_AGENT:-}" ]  || exit 0
[ -n "${PITHOS_RUN_ID:-}" ] || exit 0
case "${1:-}" in
  PreToolUse) pithos heartbeat --run "$PITHOS_RUN_ID" --hook PreToolUse --throttle-seconds 60 >/dev/null 2>&1 || true ;;
  SessionEnd) pithos run end --run "$PITHOS_RUN_ID" --status ended >/dev/null 2>&1 || true ;;
  *)          printf '{"systemMessage":"pandora-spawn dispatch.sh: unknown hook event %s; check packages/spawner/claude-plugin/hooks/hooks.json"}\n' "${1:-<empty>}" ;;
esac
