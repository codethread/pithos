# Pithos ad hoc tracer-bullet slices

**Priority:** Process this queue before `tasks.md`.
**Scope:** Observability, diagnostics, and quick repair slices.
**Source docs for current queue:** `PROMPT.md`, `mvp-spec.md`, `technical-design.md`, `ambition.md`, `spawner-spec.md`

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

## Slice AH-2 — Rename Envy queue capability to implement

**Title:** Rename Envy queue capability from `watch` to `implement`
**Status:** Built

---

## Slice AH-3 — Prevent stage/capability drift in Pandora/Toil prompts

**Title:** Stop recipe stage names leaking into queue capabilities
**Status:** Built
**Type:** AFK
**Blocked by:** AH-2
**User stories:** US10 (agent config), US11 (manual end-to-end demo)

**Vertical slice:** Strengthen Pandora/Toil prompt contracts so Envy-bound actionable work is enqueued with `--capability implement`, while names like `execute` remain at most recipe-local stage labels. Update prompt text, snapshots, and any nearby docs/examples that currently blur queue capabilities with coordination style or recipe stage IDs. Capture the exact regression from the latest rerun: Toil created capability `execute`, Envy claimed `watch`, and the flow stalled with `No claimable watch task exists`. Acceptance: no active prompt/example instructs Toil to emit `execute` or `watch` for Envy-bound work; prompt snapshots and relevant checks stay green.

---

## Slice AH-4 — Re-run the HITL delegation workflow after the capability reset

**Title:** Re-run Pandora → Toil → Envy → worker after capability reset
**Status:** Unbuilt
**Type:** HITL
**Blocked by:** AH-2, AH-3
**User stories:** US11 (manual end-to-end demo)

**Vertical slice:** Execute `PROMPT.md` from a fresh cleanup state. Seed the hello-script task, spawn Pandora manually, and observe the end-to-end delegation path. This slice is successful only if Pandora does not edit directly, Toil emits Envy-bound work with capability `implement`, Envy claims it, worker-style execution is observable, `scripts/hello.sh` exists and runs, a `worker-completion` artifact is attached, and the final report captures all required IDs/commands. Regression target: eliminate the exact failure where Envy reports `No claimable watch task exists`.

---
