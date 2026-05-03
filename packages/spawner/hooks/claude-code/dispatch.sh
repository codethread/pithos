#!/usr/bin/env bash
[ -n "${PITHOS_AGENT:-}" ]  || exit 0
[ -n "${PITHOS_RUN_ID:-}" ] || exit 0
case "${1:-unknown}" in
  SessionEnd) pithos run end --run "$PITHOS_RUN_ID" --status ended >/dev/null 2>&1 || true ;;
  *)          pithos heartbeat --run "$PITHOS_RUN_ID" --hook "$1" --throttle-seconds 60 >/dev/null 2>&1 || true ;;
esac
