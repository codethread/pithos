# Slice 12d — Race and lifecycle edge tests

## What to build

Add focused tests for race and lifecycle edges that are easy to regress.

Cover:

- concurrent claim attempts for the same claimable task: one wins, loser receives `NO_CLAIMABLE_WORK` or a loud tagged race/validation error; DB remains consistent
- fenced update race: `STALE_TOKEN_RACE` rolls back and does not partially mutate task/run/event state
- `task supersede` with mixed dependent states (`queued` + `cancelled` + `done`) fails loudly per spec
- `pdx kill` racing with natural death: if run is already terminal or resource already gone, behavior is loud and consistent with Pithos being source of truth
- orphan discovery when both tmux orphans and AFK pidfile orphans coexist
- no-claim timeout near boundary: just before 30s does not fire; at/after 30s fires once

## Test focus

- DB integrity after every race.
- No swallowed errors.
- Registry/cap cleanup after lifecycle settlement.
- Distinguish Cleanup, Interrupt, Timeout, and Cancel semantics.

## Acceptance criteria

- [ ] Concurrent claim edge covered
- [ ] Fenced race rollback covered
- [ ] Supersede mixed-dependent-state edge covered
- [ ] Kill-vs-natural-death edge covered
- [ ] Mixed orphan discovery covered
- [ ] No-claim timeout boundary covered
