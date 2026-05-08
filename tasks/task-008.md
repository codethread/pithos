# Slice 8 — Agent spawning epic

## Status

This slice is a parent epic. It was too broad as one unit because it combined spawn-policy selection, cap accounting, AFK pidfiles, and no-claim timeout behavior.

## Replacement slices

Implement in order:

1. [task-008a — Spawn policy for Toil/Greed/War](./task-008a.md)
2. [task-008b — Registry cap accounting](./task-008b.md)
3. [task-008c — AFK pidfile lifecycle](./task-008c.md)
4. [task-008d — No-claim timeout](./task-008d.md)

## Original contract retained by the split

The split still delivers the original slice-8 outcome:

- Reconcile spawns `toil`, `greed`, and `war` when claimable work exists.
- pdx never pre-claims; spawned agents claim through Pithos.
- Spawn order is seeded and simple: `toil`, then `greed`, then `war`; at most one spawn per reconcile tick.
- Per `(agent_kind, scope_id)` cap and global `--max-afk` cap are enforced from the in-memory Registry.
- Caps count `launching`, `live`, and `terminating` entries.
- Pandora and the `pdx` system run are excluded from spawnable-agent caps and no-claim timeout.
- AFK pidfiles are written for spawned AFK runs and removed during cleanup.
- Non-Pandora no-claim sessions time out after 30 seconds and become `timed_out` runs with no task mutation.

## Boundaries

- Pandora singleton and natural death cleanup are task 006.
- `pdx kill` terminating behavior is task 007.
- Wakeup transport is task 009.
- Startup orphan discovery from pidfiles is task 010.

## Acceptance criteria

- [ ] task-008a, task-008b, task-008c, and task-008d complete
- [ ] Reconcile spawns non-Pandora agents according to spec
- [ ] Caps, pidfiles, and no-claim timeout are tested independently
