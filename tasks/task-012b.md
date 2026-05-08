# Slice 12b — Stable surface snapshots

## What to build

Add snapshot coverage for stable CLI/help and JSON output surfaces.

Snapshot:

- `pithos --help`
- `pithos` subcommand help for every public nested command
- `pdx --help`
- `pdx` subcommand help for `open`, `close`, `status`, `kill`, `logs show`
- `pandora-spawn preview --help`
- `pdx status --json` minimum shape
- `pithos run inspect` JSON shape
- `pithos task inspect` JSON shape
- `pithos graph inspect` JSON shape
- `pithos briefing` JSON/markdown shape, whichever is public/stable

Use `vitest run --update` to update snapshots after intentional corrections.

## Test focus

- Removed command surfaces stay absent.
- Nested command names and flags stay stable.
- JSON minimum keys from specs are present.
- Snapshots avoid unstable IDs/timestamps by normalizing them before assertion.

## Acceptance criteria

- [ ] Help snapshots cover public CLIs
- [ ] JSON shape snapshots cover status/inspect/graph/briefing
- [ ] Snapshots normalize unstable dynamic values
