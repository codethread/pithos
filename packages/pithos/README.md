# @pithos/pithos

The `pithos-next` bin. Greenfield Pithos control-plane rewrite that ships beside the current production `packages/cli` package.

## Quick start

```sh
pnpm --filter @pithos/pithos start -- --help
pnpm --filter @pithos/pithos start -- init --fresh
```

Built bin:

```sh
pnpm --filter @pithos/pithos build
packages/pithos/bin/pithos-next --help
```

## Surface

- `pithos-next init [--fresh]`
- `pithos-next scope upsert`
- `pithos-next run upsert|inspect`
- `pithos-next task enqueue|claim|heartbeat|complete|fail|supersede|cancel|inspect`
- `pithos-next task artifact add`
- `pithos-next graph inspect`
- `pithos-next events tail`
- `pithos-next briefing`

No flat task aliases. No `sweep`. No `run end` / `run finish`.

## Environment

| Variable | Purpose |
| --- | --- |
| `PITHOS_DB` | SQLite path. Default: `~/.pandora/pithos-next.sqlite` |
| `PITHOS_RUN_ID` | Default run id for mutating task commands |
| `PITHOS_LOG_LEVEL` | `trace` / `debug` / `info` / `warning` / `error` / `fatal` / `none` |

## Output and exit codes

Successful structured commands emit JSON `{ "ok": true, ... }` on stdout. `briefing` is the only markdown command.

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | General/user error |
| `2` | Validation error |
| `3` | Not found |
| `4` | Stale fencing token |
| `5` | No claimable work |
