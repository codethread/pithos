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

## Acceptance criteria

- [ ] pdx detects new claimable escalate transitions and sends the marker
- [ ] Marker is exactly `# wakeup: claimable escalate` followed by Enter
- [ ] No spam under steady state
- [ ] `pandora.md.tmpl` documents the marker and instructs Pandora to claim on recognition

## Blocked by

- Slice 6 (task-006)
