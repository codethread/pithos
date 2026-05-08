# Slice 5a — pdx package + control-plane substrate

## What to build

Create greenfield workspace package `packages/pdx/` with bin `pdx`, but keep user-facing behavior minimal. This slice establishes the reusable substrate for later pdx slices.

Implement Effect services/layers for:

- typed pdx config: `home`, `intervalSeconds`, `maxAfk`, derived paths (`<home>/pdx.sock`, `<home>/pdx.jsonl`, `<home>/runs/`)
- `Tmux` service with methods:
  - `hasSession(target)`
  - `lsSessions()`
  - `newSession({ target, command, cwd })`
  - `killSession(target)`
  - `sendLiteralLine(target, text)`
  - `pasteBuffer(target, content)`
- `PithosClient` service for core Pithos calls used by pdx; shelling out is allowed only if no importable API exists yet, and must sit behind this service
- `Registry` service backed by an in-memory `SynchronizedRef`, initially empty
- `SupervisorLog` service that writes structured JSONL records with at least `ts`, `level`, `span`, `msg`
- `Clock`, `Ids`, `FileSystem`, and `Process` seams for tests
- Unix-socket IPC foundation at `<home>/pdx.sock`, with JSON request/response schemas parsed at the IO boundary

Rules:

- No direct `node:child_process` or shell-form tmux calls in command handlers or domain logic.
- Tmux uses exec-form argv through the process service / `@effect/platform` command APIs.
- `sendLiteralLine` must send literal text and Enter as separate tmux invocations.
- Missing or malformed config/request/log data fails with tagged errors.

## Test focus

- Config path derivation.
- `Tmux` service command argv construction, including `sendLiteralLine` two-call behavior.
- Supervisor log schema includes required fields.
- IPC request parsing rejects malformed JSON / unknown request kinds loudly.
- Registry starts empty and exposes typed entry operations without persisted state.

## Defer

- `pdx open` / `pdx close` behavior; task 005b.
- `pdx status` / `pdx logs show`; task 005c.
- Pandora lifecycle; task 006.
- Kill requests over IPC beyond schema plumbing; task 007.

## Acceptance criteria

- [ ] `packages/pdx/` exists with bin `pdx`
- [ ] Package builds, typechecks, and has substrate tests
- [ ] Tmux, PithosClient, Registry, SupervisorLog, Clock, Ids, FileSystem, and Process are service-backed
- [ ] IPC schema/parser foundation exists and rejects invalid input loudly
