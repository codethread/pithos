# Slice 12 — Test tightening for v1 epic

## Status

This slice is a parent epic. It intentionally happens after MVP behavior lands, but it is too broad as one implementation unit.

## Replacement slices

Implement in order:

1. [task-012a — MVP integration tests](./task-012a.md)
2. [task-012b — Stable surface snapshots](./task-012b.md)
3. [task-012c — Event payload schema coverage](./task-012c.md)
4. [task-012d — Race and lifecycle edge tests](./task-012d.md)
5. [task-012e — Error wording + graph performance smoke](./task-012e.md)

## Rules

- This is primarily test work, but tests are allowed to expose broken v1 contracts.
- If a test exposes a regression or missing behavior required by the specs, fix it in the owning area before marking the child slice complete.
- If a test exposes genuinely new behavior outside the specs, record an explicit follow-up and keep this slice scoped.
- Do not weaken, skip, or snapshot-around failing behavior to get green checks.

## Acceptance criteria

- [ ] task-012a through task-012e complete
- [ ] MVP happy path and kill path covered end-to-end
- [ ] Stable public surfaces snapshotted
- [ ] Every event kind has schema coverage
- [ ] Race/lifecycle edge cases covered
- [ ] Error wording and graph performance smoke covered
- [ ] `pnpm verify` green
