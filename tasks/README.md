# Tasks — Pithos MVP slices

Checklist of all 12 implementation slices, grouped by availability. Uncheck = not started. Each task file lists its specific blockers.

Your job: complete **exactly one** approved task, end-to-end, commit with a clear and informative message, then stop.

## Required reading

Read these before choosing work:

- `README.md`
- `specs/*`
- the previous and next task in the chain (gives history and helps avoid scope creep into next task)

## Workflow

- scout the codebase (and grep with hack) to get the topology
- focus on delivering an MVP with adherence to the spec
- ensure before signing off work, you run `pnpm verify` to run all checks
- ensure code passes `review` from an agent
  - ensure they have references to this task file, the task you are completing, and are instructed to read all the specs to ensure alignment of the new code
- action feedback you believe is correct and repeat
- Do not weaken tests or contracts to make validation pass.
- Fail loudly. Preserve DB integrity. Keep outputs deterministic.
- use snapshot tests and test.each to improve test code
- leverage Effect heavily for quality DI in tests and focus on a few high value tests at this stage, unless the task specifically asks

---

## Ready to start

Tasks with no unblocked dependencies — pick any.

- [x] **[1 — Pithos foundation](task-001.md):** schema, seeds, nested CLI, authorization
- [x] **[4 — Spawner in-place refactor](task-004.md):** launcher-only library + preview CLI

---

## Completed

- [x] **[2 — Run lifecycle transitions](task-002.md):** cleanup, interrupt, timeout

---

## Ready after slice 2

- [ ] **[3 — Task graph tightening + DEMO GATE 1](task-003.md):** supersede preconditions, consolidated events, demo walkthrough
- [ ] **[5 — pdx skeleton](task-005.md):** open / close / status / logs + system run

---

## Still blocked

- [ ] **[6 — Pandora singleton + death detection + DEMO GATE 2](task-006.md):** reconcile loop, Pandora lifecycle, respawn
  - ↳ Blocked by: task-004, task-005
- [ ] **[7 — pdx kill flow](task-007.md):** interrupt → escalate → kill → retry
  - ↳ Blocked by: task-006
- [ ] **[8 — Agent spawning](task-008.md):** caps, no-claim timeout, pidfiles
  - ↳ Blocked by: task-006
- [ ] **[9 — Wakeup transport + Pandora marker](task-009.md):** escalate transition → tmux wakeup
  - ↳ Blocked by: task-006
- [ ] **[10 — Orphan discovery](task-010.md):** reap stale HITL/AFK sessions on `pdx open`
  - ↳ Blocked by: task-005

---

## Blocked on everything

- [ ] **[11 — Cutover](task-011.md):** retire `packages/cli/`, point `pithos` bin at new package
  - ↳ Blocked by: all of tasks 1–10
- [ ] **[12 — Test tightening](task-012.md):** MVP integration test, snapshot tests, edge cases
  - ↳ Blocked by: task-011

---

## Dependency graph

```
001 ─┬─ 002 ─┬─ 003 (demo gate 1)
     │       ├─ 005 ─┬─ 010
     │       │       └─ 006 ─┬─ 007
     │       │               ├─ 008
     │       │               └─ 009
     │       └─ (002 is also a transit dep of 005,006,007,008,010)
     │
     └─ 004 ─── 006
                     \
                      └── 011 ─── 012
```

**Critical path:** `001 → 002 → 006 → 011 → 012` (longest chain).

Demo gates: task-003 (gate 1) and task-006 (gate 2) are independent of each other but both must be done before slice 11 cutover.

---

> **Tip:** Each task file lists its own `## Blocked by` section. After completing a task, check which downstream tasks are newly unblocked and update this file's checkboxes.

## Output contract

### If you completed the slice successfully

Stop and provide a brief summary of work completed

### If you cannot complete the slice or all slices are now complete

Reply with exactly:

`COMPLETE`

and **nothing else**.

Do not include any extra text.
