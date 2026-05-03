# Pithos ad hoc tracer-bullet slices

**Priority:** Process this queue before `tasks.md`.
**Scope:** Observability, diagnostics, and quick repair slices.

---

## Slice AH-1 — Claude Code Plugin (declarative hook install)

**Title:** Claude Code plugin for declarative hook registration
**Status:** Built
**Type:** AFK
**Blocked by:** None
**User stories:** US10 (Nix-safe hook install)

**Vertical slice:** Users on Nix/home-manager setups where `~/.claude/settings.json` is a read-only symlink cannot run `pandora-spawn hooks install`. This slice ships a Claude Code plugin (`plugin/`) that registers the identical `PreToolUse` and `SessionEnd prompt_input_exit` hooks declaratively via `hooks/hooks.json`, referencing the existing `dispatch.sh` through `${CLAUDE_PLUGIN_ROOT}`. A `marketplace.json` at repo root allows one-time install via `/plugin marketplace add codethread/pithos`. The CLI install path is unchanged and remains the manual fallback.

**Files created:**
- `plugin/.claude-plugin/plugin.json` — plugin manifest
- `plugin/hooks/hooks.json` — hook registrations
- `plugin/README.md` — install instructions
- `marketplace.json` — marketplace manifest at repo root

---
