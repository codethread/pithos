# Slice 5b — pdx open/close + pdx system run

## What to build

Implement the first usable pdx daemon lifecycle using the substrate from task 005a.

`pdx open [--data-dir <path>] [--interval-seconds <n>] [--max-afk <n>]`:

1. Fail loudly if tmux session `pdx--daemon` already exists.
2. Run non-destructive `pithos init` through `PithosClient`.
3. Create `<data-dir>/runs/` for later AFK pidfiles.
4. Start the daemon in tmux target `pdx--daemon`.
5. Daemon binds the Unix socket and opens the Supervisor log.
6. Daemon upserts the `pdx` system run in global scope: `agent=pdx`, `mode=afk`, `scope=global`, `cwd=<data-dir>`.
7. CLI exits successfully once daemon startup is confirmed.

`pdx close [--data-dir <path>]`:

1. Fail loudly if no daemon is running.
2. Tell the daemon to stop over the IPC seam.
3. Stop reconcile/resources in scoped-finalizer order.
4. Cleanup the `pdx` system run last with reason `pdx_close`.
5. Close/kill tmux session `pdx--daemon`.

Finalizer ordering matters: the `pdx` system run cleanup finalizer must be registered first so it runs last.

Because Pandora is not launched until task 006, this slice must not claim that `pdx--pandora` is live. If the CLI prints an attach hint, it must make clear Pandora starts in task 006; otherwise defer the attach hint to task 006.

## Test focus

- `pdx open` rejects when `pdx--daemon` already exists.
- `pdx open` runs non-destructive `pithos init`.
- `pdx open` creates `<data-dir>/runs/`.
- `pdx` system run is upserted on daemon startup.
- `pdx close` rejects when no daemon is running.
- `pdx close` sends daemon stop and cleans the system run last.
- No Pandora registry entry or tmux session is created in this slice.

## Defer

- Startup orphan discovery; task 010.
- Pandora singleton/open attach readiness; task 006.
- Status/log querying; task 005c.
- Kill flow; task 007.

## Acceptance criteria

- [ ] `pdx open` starts `pdx--daemon` and confirms daemon readiness
- [ ] `pdx close` stops `pdx--daemon`
- [ ] pdx system run lifecycle is correct and cleaned up last
- [ ] No Pandora launch occurs before task 006
