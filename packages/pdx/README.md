# @pithos/pdx

Local supervisor skeleton for Pandora's Box.

## Surface

- `pdx open`
- `pdx close`
- `pdx status --json`
- `pdx logs show`

Slice 5 provides the daemon shell, pdx system run management, structured supervisor log, and operator status/log access. Agent spawning arrives in later slices.

## Build

```sh
pnpm --filter @pithos/pdx build
PITHOS_BIN=packages/pithos/bin/pithos-next pnpm --filter @pithos/pdx start -- open --home /tmp/pdx-home
```

## Tests

```sh
pnpm --filter @pithos/pdx test
```
