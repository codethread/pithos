# @pithos/pdx

Local supervisor skeleton for Pandora's Box.

## Surface

- `pdx open`
- `pdx close`
- `pdx status --json`
- `pdx logs show`

Current MVP state:

- daemon shell + pdx system run
- Pandora singleton maintained in tmux as `pdx--pandora`
- reconcile-loop natural death detection + respawn with a fresh run id
- structured supervisor JSONL log + operator status/log access

Non-Pandora spawning, kill flow, wakeups, and orphan discovery arrive in later slices.

## Build

```sh
pnpm --filter @pithos/pdx build
PITHOS_BIN=packages/pithos/bin/pithos-next pnpm --filter @pithos/pdx start -- open --home /tmp/pdx-home
```

## Tests

```sh
pnpm --filter @pithos/pdx test
```

## Demo

Replayable walkthrough: [`../../docs/demos/pdx-pandora.md`](../../docs/demos/pdx-pandora.md)
