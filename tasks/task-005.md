# Slice 5 — pdx skeleton: open / close / status / logs + system run

## What to build

New greenfield workspace package `packages/pdx/`. Bin: `pdx`.

`pdx open [--home <path>] [--interval-seconds <n>] [--max-afk <n>]`:

1. Fail loud if a `pdx--daemon` tmux session already exists.
2. Run `pithos init` (non-destructive).
3. Start daemon process inside tmux session named `pdx--daemon`.
4. Upsert the `pdx` system run: `agent=pdx`, `mode=afk`, `scope=global`, `cwd=<home>`. This run never holds a task and is the durable authoring identity for supervisor-created tasks (slice 7 uses it).
5. Create `<home>/runs/` directory for AFK pidfiles.
6. Open structured JSONL log at `<home>/pdx.jsonl`. Every line includes at least `ts`, `level`, `span`, `msg` (per spec §8 + project rule 4 on observability).
7. Print `tmux attach -t pdx--pandora` on success and exit. Pandora itself comes in slice 6 — for this slice, the message can be printed even without a live Pandora, or guarded; implementer choice.

`pdx close [--home <path>]`:

- Fail loud if no daemon is running.
- Stop reconcile.
- (Slice 6+ kill agent runs first; slice 5 has none beyond pdx system run.)
- `pithos run cleanup` the `pdx` system run **last**, with reason `pdx_close`.
- Close the `pdx--daemon` tmux session.

`pdx status [--home <path>] [--json]`:

- JSON output is mandatory; `--json` may be the only mode in MVP.
- Required top-level keys: `daemon`, `registry`, `queue`, `caps`. Sub-shape is intentionally loose; should include daemon liveness, in-memory registry entries with raw IDs and friendly names, claimable queue counts by scope/capability, cap usage, recent supervisor events/errors.
- If no daemon is running, return successful JSON with `daemon.running = false` (do not error).
- If state cannot be determined due to tmux/process errors, fail loud.

`pdx logs show [--home <path>] [--limit <n> | --all] [--since <when>]`:

- Reads structured supervisor JSONL even when daemon is stopped.
- Default last 100 lines.
- `--since` accepts ISO timestamps, durations (`10m`, `1h`, `2d`, `1w`), `today`, `yesterday`. `today`/`yesterday` use local-time boundaries.
- Missing/unreadable log file, invalid `--since`, or corrupt JSONL fails loud.
- Output is raw original JSONL passthrough; pipe-friendly for `jq`.

In-memory registry data structures present but empty in this slice. Slice 6 begins populating it.

Effect.ts service shapes follow patterns from existing packages: DI for clock, IDs, filesystem, process exec, tmux. Expose a `Tmux` service via the existing DI pattern; do not call `child_process` for tmux directly. Spawner is pulled in as a library dependency (no use yet — slice 6 wires it).

## Test focus

- `pdx open` rejects when daemon already running
- `pdx close` rejects when no daemon
- pdx system run upserted on open and cleaned up last on close
- `pdx status --json` shape: required top-level keys present in both daemon-up and daemon-down cases
- `pdx status --json` returns `daemon.running = false` cleanly when no daemon (does not error)
- `pdx logs show --since` accepts every documented form; rejects malformed input loudly
- Supervisor log lines include `ts`, `level`, `span`, `msg`

Defer: tmux mock fidelity beyond happy path; supervisor log content assertions beyond the schema.

## Acceptance criteria

- [ ] `packages/pdx/` builds and tests green
- [ ] `pdx open` / `pdx close` / `pdx status` / `pdx logs show` round-trip works
- [ ] pdx system run created on open and cleaned up last on close
- [ ] `pdx status` JSON has required top-level keys; `daemon.running=false` on no-daemon
- [ ] Supervisor log lines validated against minimum schema
- [ ] `pdx open` / `pdx close` exit codes and error wording are loud

## Blocked by

- Slice 1 (task-001)
- Slice 2 (task-002) — `pdx close` cleans up the pdx system run via `pithos run cleanup`
