# Slice 12a — MVP integration tests

## Status

Complete in current working tree.

## What to build

Add end-to-end MVP integration coverage across Pithos, spawner, and pdx using test harness seams so CI does not require real Anthropic credentials or real model binaries.

Cover the happy path:

1. `pdx open` starts daemon and Pandora singleton.
2. Pandora/global setup enqueues or records initial work through Pithos.
3. A seeded repo/worktree scope receives claimable `triage` work.
4. Reconcile spawns Toil.
5. Toil claims and decomposes into `design` and checkpoint `escalate` work.
6. Reconcile spawns Greed.
7. Greed claims and produces a design artifact.
8. New claimable `escalate` triggers Wakeup.
9. Pandora claims and completes the escalation task.
10. `pdx close` tears down Registry entries, Pandora, daemon, and the `pdx` system run in order.

Cover the kill path:

1. Spawn a Greed or War run and let it hold a task.
2. `pdx run kill <id> --reason <text>`.
3. Observe Pithos `Interrupt`: held task becomes `failed`, Fencing token increments.
4. Observe system-authored global Repair Alert (kind=`interrupt`).
5. Observe Pandora can claim/complete the escalation.

## Test focus

- Cross-package happy path works without raw SQL.
- The daemon never injects task content into prompts.
- Agents claim through Pithos, not pdx pre-claim.
- pdx reuses `@pithos/pithos` directly for supervisor-owned Pithos operations; only agent recipes exercise the CLI surface.
- Kill mutates Pithos before killing resources.
- Close order matches spec.

## Acceptance criteria

- [x] MVP happy path integration test passes
- [x] Kill/interruption/escalation path integration test passes
- [x] Tests use injected/mocked harness seams, not real model credentials

## Implementation notes

Coverage lives in `packages/pdx/test/substrate.test.ts` and uses real Pithos engine/DB state with fake pdx Spawner/Process/Tmux seams. The tests intentionally avoid asserting unresolved no-claim post-timeout retry/escalation policy beyond the current minimal timeout behavior.
