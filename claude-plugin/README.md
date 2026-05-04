# Pithos Claude Code Plugin

Declarative Claude Code plugin that registers Pithos liveness and session-end hooks without mutating `~/.claude/settings.json`. This is the preferred install method on Nix systems where `~/.claude/settings.json` is a read-only home-manager symlink.

## What ships

- **`hooks/hooks.json`** — two hook registrations:
  - `PreToolUse`: throttled `pithos heartbeat` so the sweep daemon does not flag active runs as stale (60 s throttle).
  - `SessionEnd` (matcher: `prompt_input_exit`): `pithos run end --status ended` to close the run cleanly when the agent process actually terminates.

Both hooks delegate to the existing `packages/spawner/hooks/claude-code/dispatch.sh` via `${CLAUDE_PLUGIN_ROOT}`. The script is a no-op in normal Claude sessions — it exits immediately unless `PITHOS_AGENT` and `PITHOS_RUN_ID` are set, which `pandora-spawn` injects at spawn time.

No bins, agents, or skills are shipped — `pithos` and `pandora-spawn` are already linked globally by `pnpm run build`, and agent templates live in `packages/spawner/templates/`.

## Prerequisites

The plugin requires the repo to be cloned and built — `pithos` and `pandora-spawn` must be on PATH. Run once:

```sh
git clone https://github.com/codethread/pithos
cd pithos
pnpm install && pnpm run build
```

`pnpm run build` links both bins globally. The hook script (`dispatch.sh`) exits immediately in normal sessions; `pithos` only needs to be on PATH when `pandora-spawn` has spawned a session with `PITHOS_AGENT` and `PITHOS_RUN_ID` set.

## Install via marketplace (recommended)

```sh
# Register this repo as a marketplace source (one-time)
/plugin marketplace add https://github.com/codethread/pithos

# Install the plugin
/plugin install pithos@codethread/pithos
```

Once installed, Claude Code loads the hooks automatically on every session.

## Install for local dev

If you are working on the plugin itself or want to test before publishing:

```sh
# Point Claude Code at the local plugin directory
claude --plugin-dir ./claude-plugin
```

Or add to your project `.claude/settings.json`:

```json
{
  "pluginDirs": ["./claude-plugin"]
}
```

## Manual fallback (non-Nix)

On systems where `~/.claude/settings.json` is writable, the CLI install still works:

```sh
pandora-spawn hooks install
```

This merges the same two hook entries directly into `~/.claude/settings.json`. Use the plugin install instead if that file is read-only.
