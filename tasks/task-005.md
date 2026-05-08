# Slice 5 — pdx skeleton epic

## Status

This slice is a parent epic. It was too broad as one implementation unit because it mixed package creation, daemon lifecycle, service substrate, IPC, structured logging, status, and log-query UX.

## Replacement slices

Implement in order:

1. [task-005a — pdx package + control-plane substrate](./task-005a.md)
2. [task-005b — pdx open/close + pdx system run](./task-005b.md)
3. [task-005c — pdx status + logs show](./task-005c.md)

Downstream tasks that need a usable pdx operator surface should depend on `task-005c`. Tasks that only need the daemon/open substrate may depend on `task-005b` explicitly.

## Original contract retained by the split

The split still delivers the original slice-5 outcome:

- New greenfield workspace package `packages/pdx/` with bin `pdx`.
- `pdx open [--home <path>] [--interval-seconds <n>] [--max-afk <n>]` starts the local supervisor daemon in tmux target `pdx--daemon` after non-destructive `pithos init`.
- `pdx close [--home <path>]` stops the daemon and cleans the `pdx` system run last.
- `pdx status [--home <path>] [--json]` returns JSON with top-level `daemon`, `registry`, `queue`, and `caps`.
- `pdx logs show [--home <path>] [--limit <n> | --all] [--since <when>]` reads the structured Supervisor log as raw JSONL.
- Tmux/process/filesystem/clock/IDs/Pithos access sit behind Effect services/layers.
- Supervisor logs are structured JSONL; no unstructured daemon logs.
- Registry exists as an in-memory concept but remains empty until task 006 populates Pandora.

## Boundaries

- Pandora singleton launch belongs to task 006.
- Toil/Greed/War spawning, caps, no-claim timeout, and pidfiles belong to task 008.
- Startup orphan discovery belongs to task 010.
- `pdx kill` belongs to task 007.

## Acceptance criteria

- [ ] task-005a, task-005b, and task-005c complete
- [ ] `packages/pdx/` builds and tests green
- [ ] `pdx open` / `pdx close` / `pdx status` / `pdx logs show` round-trip works without spawning Pandora
- [ ] pdx system run is created on open and cleaned up last on close
- [ ] Supervisor log lines validate against minimum schema
