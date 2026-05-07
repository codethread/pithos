# Slice 9 — Wakeup transport + Pandora marker recognition

## What to build

Two coupled changes that complete the supervisor → Pandora attention path.

pdx side (in `packages/pdx/`):

- Each reconcile tick, after lifecycle settlement, observe whether new claimable `escalate` work exists in global scope that did not exist on the previous tick.
- When that condition transitions from false to true, send a content-free wakeup via `tmux send-keys -t pdx--pandora` with the marker line followed by Enter:

  ```text
  # wakeup: claimable escalate
  ```

- Steady-state behavior: do not spam. Once the marker has been sent for a given claimable-escalate population, do not resend until either:
  - Pandora claims (queue transitions back through zero claimable escalates), or
  - new claimable escalates appear after she clears the queue.
- Wakeup is content-free. No task body, no metadata, no semantic injection.

Pandora template side (in `packages/spawner/templates/pandora.md.tmpl`):

- Add an instruction that tells Pandora to recognize the literal marker line `# wakeup: claimable escalate`.
- On recognition: she runs her normal claim recipe (`pithos task claim --capability escalate --scope global --run <her-run-id>`), inspects the task, and works it.
- The marker is content-free by design — Pandora must not treat it as task content.

## Test focus

- Wakeup fires when an `escalate` task transitions from queued-but-blocked / non-existent to claimable in global scope
- Wakeup does **not** fire repeatedly while the claimable-escalate population is unchanged
- `tmux send-keys` invoked against the correct target (`pdx--pandora`)
- Pandora template includes the marker recognition instruction (template-text assertion is acceptable)

Defer: end-to-end "Pandora actually claims via marker" flow — covered by the MVP integration test in slice 12.

## Implementation primitives

Builds on task-005 §Implementation primitives (Tmux service) and task-006 §Implementation primitives (registry, reconcile).

- **Transition detection:** registry holds `lastEscalateClaimableCount: number`. Each reconcile tick, after lifecycle settlement, query Pithos for the current count of claimable global escalate tasks (queued, dependencies met). `0 → >0` transition fires the wakeup; `>0 → 0` resets the latched flag. No `Stream.changesWithEffect` needed since we already poll in the reconcile tick.
- **Wakeup transport:** `Tmux.sendLiteralLine("pdx--pandora", "# wakeup: claimable escalate")` from task-005. Two `tmux send-keys` calls under the hood: `-l` text then `Enter`. No shell, no escaping, no key-name interpretation. Marker is content-free per spec.
- **No spam guarantee:** `lastEscalateClaimableCount` is the only source of "should we send". Reconcile is idempotent on each tick — no extra timers.
- **Pandora template change:** literal-string assertion in the test — the template must contain `# wakeup: claimable escalate` as instruction text. Pandora reads it from her prompt context, not from the marker itself.

## Acceptance criteria

- [ ] pdx detects new claimable escalate transitions and sends the marker
- [ ] Marker is exactly `# wakeup: claimable escalate` followed by Enter
- [ ] No spam under steady state
- [ ] `pandora.md.tmpl` documents the marker and instructs Pandora to claim on recognition

## Blocked by

- Slice 6 (task-006)
