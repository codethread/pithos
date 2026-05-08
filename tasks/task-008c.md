# Slice 8c — AFK pidfile lifecycle

## What to build

Add pdx-owned AFK pidfiles for spawned AFK agents.

Behavior:

- On AFK launch, write `<home>/runs/<run-id>.pid` containing the pid.
- Write atomically using tmp + rename.
- On Pithos `run cleanup` for that run, remove the pidfile.
- Do not remove the pidfile merely because the process exits; crashed pdx must leave pidfiles for task 010 orphan discovery.
- HITL runs do not get pidfiles.

This slice only covers pidfile lifecycle for Registry-created AFK runs. Startup orphan discovery from existing pidfiles is task 010.

## Test focus

- AFK launch writes pidfile with the process pid.
- Write is tmp + rename.
- Cleanup removes pidfile.
- Natural process exit alone does not remove pidfile without cleanup.
- HITL launch writes no pidfile.
- Missing pidfile during cleanup is handled idempotently only if cleanup state already proves the run is settled; otherwise fail loudly on unexpected filesystem errors.

## Defer

- Reading pidfiles on startup; task 010.
- No-claim timeout; task 008d.

## Acceptance criteria

- [ ] AFK pidfiles written at launch
- [ ] AFK pidfiles removed during cleanup
- [ ] Pidfiles intentionally survive process exit until cleanup/orphan discovery
- [ ] HITL sessions do not create pidfiles
