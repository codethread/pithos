# Task 7: Add dynamic gate claimability

## Scope

Type: AFK

Add the `gate` edge as a first-class coordination primitive: a gated queued task is claimable only after the target branch closure has drained successfully.

## Must implement exactly

- Add `--gate-on <task-id>` to `pithos task enqueue` as a repeatable blocking edge flag that creates `gate` edges.
- Extend chain policy so held `gate` escalation to normal continuation creates an `after` edge to the held escalation, matching checkpoint escalation semantics in the diff spec.
- Implement branch closure from a gate target exactly as the diff spec defines it: start at the canonical target and traverse incoming `after`, `about`, and `repair` edges; exclude `gate` edges from branch membership.
- Implement canonical Supersession replacement lookup for gate closure and gate satisfaction.
- Implement gate states for internal/read-model use: clear, open, and broken.
- Update Claim selection so a queued task with outgoing `gate` edges is claimable only when every gated branch closure is clear.
- Add `task_gate_releases` and `task_gate_release_members` tables and write per-attempt release snapshots inside the same transaction as Claim.
- Ensure requeued tasks do not reuse old gate releases for claimability; each Claim attempt records fresh release rows.
- Reject gate edges fail-loud when the gate owner is already in `branchClosure(target)`.
- Reject direct gate self-dependencies and multi-task blocking/gate cycles fail-loud at edge insertion.
- Emit a `task.gate_released` event in the Claim transaction with gated task id, target anchor id, attempt, fencing token, release run id, and release member snapshot ids.
- Add tests for linear branch growth, branched closure, immediate escalation inside closure, repair alert inside closure, checkpoint escalation continuation, broken closure, Supersession canonicalization, invalid gate-owner-in-target-closure edges, blocking/gate cycles, per-attempt release snapshots, and gate-release events.

## Done when

- A task with `--gate-on c` remains unclaimable while any canonical member of `branchClosure(c)` is queued, claimed, or running.
- The same task becomes claimable when all canonical branch members are `done`.
- The same task remains unclaimable and inspectably broken when any canonical branch member is failed, cancelled, or dead-lettered without transparent Supersession replacement.
- Claiming a gate-cleared task writes gate release and release-member rows keyed by attempt.
- Reclaiming a requeued gated task writes a distinct release for the new attempt.
- Held checkpoint escalation continuation creates an `after` edge to the held escalation.
- Gate-owner-in-target-closure and multi-task gate/blocking cycles fail loudly without partial edge insertion.
- Gate release events expose the attempt/fencing/snapshot data required by the diff spec.
- Relevant Pithos tests pass.

## Out of scope

- Late branch-growth rejection after a gate has released.
- Human-readable renderer polish beyond fields needed for tests.
- Priority, root-admission, or scope-hold scheduling.
- Canonical spec fold-in.

## References

- `specs/task-graph-typed-edges-diff.md`
- `packages/pithos/src/db.ts`
- `packages/pithos/src/engine/claim-loop.ts`
- `packages/pithos/src/engine/task-read-model.ts`
- `packages/pithos/src/chain-policy.ts`
- `packages/pithos/test/task-lifecycle.test.ts`
- `packages/pithos/test/chain-policy.test.ts`
