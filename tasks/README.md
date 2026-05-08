# Task index

Central dependency map for implementation slices. Individual task files describe scope and acceptance only; blockers live here.

- [ ] [task-001 — Slice 1: Pithos foundation: schema, seeds, nested CLI, authorization](./task-001.md)
  - **Status:** pending
  - **Blocked by:** none
- [ ] [task-002 — Slice 2: Run lifecycle transitions: cleanup, interrupt, timeout](./task-002.md)
  - **Status:** pending
  - **Blocked by:** [task-001](./task-001.md)
- [ ] [task-003 — Slice 3: Task graph tightening + DEMO GATE 1](./task-003.md)
  - **Status:** pending
  - **Blocked by:** [task-001](./task-001.md), [task-002](./task-002.md)
- [ ] [task-004 — Slice 4: Spawner in-place refactor: launcher-only library + preview CLI](./task-004.md)
  - **Status:** pending
  - **Blocked by:** [task-001](./task-001.md)
- [ ] [task-005 — Slice 5: pdx skeleton: open / close / status / logs + system run](./task-005.md)
  - **Status:** pending
  - **Blocked by:** [task-001](./task-001.md), [task-002](./task-002.md)
- [ ] [task-006 — Slice 6: Pandora singleton + death detection + DEMO GATE 2](./task-006.md)
  - **Status:** pending
  - **Blocked by:** [task-002](./task-002.md), [task-004](./task-004.md), [task-005](./task-005.md)
- [ ] [task-007 — Slice 7: pdx kill flow](./task-007.md)
  - **Status:** pending
  - **Blocked by:** [task-002](./task-002.md), [task-006](./task-006.md)
- [ ] [task-008 — Slice 8: Agent spawning: caps, no-claim timeout, pidfiles](./task-008.md)
  - **Status:** pending
  - **Blocked by:** [task-002](./task-002.md), [task-006](./task-006.md)
- [ ] [task-009 — Slice 9: Wakeup transport + Pandora marker recognition](./task-009.md)
  - **Status:** pending
  - **Blocked by:** [task-006](./task-006.md)
- [ ] [task-010 — Slice 10: Orphan discovery on `pdx open`](./task-010.md)
  - **Status:** pending
  - **Blocked by:** [task-002](./task-002.md), [task-005](./task-005.md)
- [ ] [task-011 — Slice 11: Cutover: retire `packages/cli/`, point `pithos` bin at new package](./task-011.md)
  - **Status:** pending
  - **Blocked by:** [task-001](./task-001.md), [task-002](./task-002.md), [task-003](./task-003.md), [task-004](./task-004.md), [task-005](./task-005.md), [task-006](./task-006.md), [task-007](./task-007.md), [task-008](./task-008.md), [task-009](./task-009.md), [task-010](./task-010.md)
- [ ] [task-012 — Slice 12: Test tightening for v1](./task-012.md)
  - **Status:** pending
  - **Blocked by:** [task-011](./task-011.md)
