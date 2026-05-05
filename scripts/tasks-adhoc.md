# Pithos ad hoc tracer-bullet slices

**Priority:** Process this queue before `scripts/tasks.md`.
**Scope:** Observability, diagnostics, and quick repair slices.
**Source docs for current queue:** `README.md`, `packages/cli/README.md`, `packages/cli/CONTRIBUTING.md`, `packages/spawner/README.md`, `packages/spawner/HOOKS.md`, `packages/spawner/CONTRIBUTING.md`

---

## Slice AH-1 — Claude Code Plugin (declarative hook install)

**Title:** Claude Code plugin for declarative hook registration
**Status:** Built
**Type:** AFK
**Blocked by:** None
**User stories:** US10 (Nix-safe hook install)

**Vertical slice:** Users on Nix/home-manager setups where `~/.claude/settings.json` is a read-only symlink cannot run `pandora-spawn hooks install`. This slice ships a Claude Code plugin (`claude-plugin/`) that registers the identical `PreToolUse` and `SessionEnd prompt_input_exit` hooks declaratively via `hooks/hooks.json`, referencing the existing `dispatch.sh` through `${CLAUDE_PLUGIN_ROOT}`. A repo-root `.claude-plugin/marketplace.json` allows one-time install via `/plugin marketplace add codethread/pithos`. The CLI install path is unchanged and remains the manual fallback.

**Files created:**
- `claude-plugin/.claude-plugin/plugin.json` — plugin manifest
- `claude-plugin/hooks/hooks.json` — hook registrations
- `claude-plugin/README.md` — install instructions
- `.claude-plugin/marketplace.json` — marketplace manifest at repo root

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

## Slice AH-7 — Emit error JSON on stdout (agents don't read exit codes)

**Title:** Move error output from exit codes to machine-readable JSON on stdout
**Status:** Pending
**Type:** AFK
**Blocked by:** None
**User stories:** US11 (agent-facing CLI contract)

**Vertical slice:** HITL session introspection revealed that agents never check `$?` — they pipe `2>&1` and parse the combined stdout/stderr stream. The current `PithosError` path already emits `{"ok":false,"error":{"code":"...","message":"..."}}` to **stderr**, but agents merge streams and parse it. Two gaps remain:

1. **Non-PithosError failures** (validation, help, unknown errors) print free-form text from `@effect/cli` to stderr, then exit 2. Agents see raw text they can't parse.
2. **`_common.md` invariants** instruct *"Check process exit codes before parsing output"* — a contract no agent actually follows (session evidence: all agents pipe `2>&1` and never check `$?`).

**Changes:**
- Collapse exit codes to 0 (success) / 1 (failure). Error details live in the JSON body: `{"ok":false,"error":{"code":"STALE_TOKEN","message":"..."}}`. No consumer branches on exit codes 2-5 — only `_common.md` tells agents to, and they ignore it.
- Route ALL error output to **stdout** as structured JSON. `PithosError` already does this (to stderr); extend catchAll to match.
- Remove `exitCodeFor()` mapping — all PithosError codes → exit 1.
- Update `_common.md`: replace exit-code-based invariants ("Exit code 4 means stale token", "Exit code 5 means no claimable work") with JSON-based equivalents ("Parse JSON; `ok:false` with `error.code` of `STALE_TOKEN` means stale fencing token").
- Update `skills/pithos-cli/SKILL.md` to match.
- Update `--help` text in claim, complete, heartbeat, fail, run to remove specific exit code references — just "0 success, 1 failure".
- Tests: `exec.ts` already only checks `exitCode !== 0` — no change needed.

**Acceptance:**
- All failure paths emit `{"ok":false,"error":{"code":"...","message":"..."}}` on stdout, exit 1.
- `_common.md` and SKILL.md invariants updated to JSON-based error reading.
- `--help` text simplified to 0/1 exit codes.
- Snapshot updated if spawner help capture changes.
- `pnpm test` green.
