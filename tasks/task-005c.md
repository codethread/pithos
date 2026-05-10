# Slice 5c — pdx status + logs show

## What to build

Implement Pandora/operator introspection commands over the pdx substrate from tasks 005a/005b.

`pdx status [--data-dir <path>] [--json]`:

- JSON output is mandatory; `--json` may be accepted as the only mode.
- Required top-level keys: `daemon`, `registry`, `queue`, `caps`.
- If no daemon is running, return success with `daemon.running = false`.
- If state cannot be determined due to tmux/process errors, fail loudly.
- Registry may be empty in this slice.
- Queue counts come from Pithos claimable-task inspection, grouped at least by scope/capability when available.
- Caps shape includes configured `max_afk`, with zero usage while registry is empty.

`pdx logs show [--data-dir <path>] [--limit <n> | --all] [--since <when>]`:

- Reads the structured Supervisor log even when daemon is stopped.
- Prints raw original JSONL lines, preserving pipe-friendliness for `jq`.
- Default: last 100 lines.
- `--limit <n>`: last N matching lines.
- `--all`: all matching lines.
- `--since <when>` filters by log timestamp before limit.
- Accepted `--since` forms:
  - ISO timestamp
  - durations: `10m`, `1h`, `2d`, `1w`
  - `today`, `yesterday` using local-time boundaries
- Missing/unreadable log file, invalid `--since`, or corrupt JSONL fails loudly.

## Test focus

- `status --json` required top-level keys in daemon-up and daemon-down cases.
- daemon-down status succeeds with `daemon.running = false`.
- tmux/process status errors fail loudly.
- `logs show` default/limit/all behavior.
- `logs show --since` accepts every documented form and rejects malformed input.
- Corrupt JSONL fails loudly.
- Raw JSONL lines are passed through unchanged.

## Defer

- Rich registry entries; task 006 and task 008 populate them.
- Wakeup visibility; task 009.
- Full status snapshot tests; task 012.

## Acceptance criteria

- [ ] `pdx status --json` works with and without a daemon
- [ ] Status includes `daemon`, `registry`, `queue`, and `caps`
- [ ] `pdx logs show` implements limit/all/since contracts
- [ ] Logs command preserves raw JSONL output
