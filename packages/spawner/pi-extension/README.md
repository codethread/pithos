# Pithos Pi extension

Tiny Pi extension that wires Pithos liveness and session-end observation hooks into Pi.
It is the Pi equivalent of the Claude Code plugin and forwards Pi lifecycle events into the shared [`../hooks/dispatch.sh`](../hooks/dispatch.sh) contract documented in [`../README.md#harness-hooks`](../README.md#harness-hooks).

## What it does

- `tool_call` → `dispatch.sh PreToolUse`
- `session_shutdown` with `reason !== "reload"` → `dispatch.sh SessionEnd`
- both are gated by `PITHOS_SESSION_ID` so replacement Pi sessions do not heartbeat against the wrong run

The dispatcher no-ops unless `pandora-spawn` injected `PITHOS_AGENT` and `PITHOS_RUN_ID`, so it is safe to keep installed for normal Pi sessions. `pdx` still owns run finalization.

## Install

`packages/spawner` is a Pi package. Install it from git so Pi auto-discovers `pi-extension/` via the package manifest:

```sh
pi install git:github.com/codethread/pithos
```

For a pinned ref:

```sh
pi install git:github.com/codethread/pithos@<ref>
```

## Quick test

```sh
pi --extension ./packages/spawner/pi-extension
```

`pandora-spawn --harness pi` already injects this extension with `--extension`, so spawned Pithos sessions do not need any permanent Pi settings changes.

## Local dev

Project-local via `.pi/settings.json`:

```json
{
  "packages": ["../packages/spawner"]
}
```

Or symlink the package root into your global Pi package dir:

```sh
mkdir -p ~/.pi/agent/git/codethread
ln -sfn "$(pwd)/packages/spawner" ~/.pi/agent/git/codethread/pithos
```
