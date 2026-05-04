# Pithos ad hoc tracer-bullet slices

**Priority:** Process this queue before `tasks.md`.
**Scope:** Observability, diagnostics, and quick repair slices.
**Source docs for current queue:** `mvp-spec.md`, `technical-design.md`, `ambition.md`, `spawner-spec.md`

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
**Status:** Built
**Type:** HITL
**Blocked by:** AH-2, AH-3
**User stories:** US11 (manual end-to-end demo)

**Vertical slice:** Execute `PROMPT.md` from a fresh cleanup state. Seed the hello-script task, spawn Pandora manually, and observe the end-to-end delegation path. Success criteria: Pandora does not edit directly, Toil emits Envy-bound work with capability `implement`, Envy claims it, a separate worker sub-session performs the file mutation, `scripts/hello.sh` exists and runs, Envy attaches a `worker-completion` artifact, and the final report captures all required IDs/commands. Current outcome: full success achieved. The `execute`/`watch` capability mismatch is gone, worker-style execution is observable, and the artifact contract is `worker-completion`.

---

## Slice AH-5 — Force Envy to delegate mutating implementation work to a worker

**Title:** Envy must not perform repo mutations directly
**Status:** Built
**Type:** AFK
**Blocked by:** AH-4
**User stories:** US11 (manual end-to-end demo)

**Vertical slice:** Tighten the Envy/Toil execution contract so mutating implementation work is delegated to a worker sub-session instead of being edited directly by Envy. Update the relevant prompt/task instructions and supporting docs/snapshots so the hello-script rerun is only considered successful when a separate worker performs the file mutation and Envy remains a coordinator/reporter.

---

## Slice AH-6 — Emit `worker-completion` artifacts for worker-backed execution

**Title:** Normalize worker result artifacts to `worker-completion`
**Status:** Built
**Type:** AFK
**Blocked by:** AH-4
**User stories:** US11 (manual end-to-end demo)

**Vertical slice:** Fix the Envy/Toil handoff instructions so worker-backed execution results in `pithos artifact add --kind worker-completion` rather than `completion`. Update prompt/task wording and nearby docs/examples accordingly, and keep the rerun acceptance criteria aligned with that artifact contract.

---
