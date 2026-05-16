# AFK task plan

This directory now tracks only unfinished follow-up work. Historical implementation notes were condensed into [`history.md`](./history.md); completed task files and the old archive index were removed from the active workspace.

## Active work

See [`index.yml`](./index.yml). Current entries are all pending triage candidates recovered from the old archive:

- `task-012b` — stable surface snapshots
- `task-012c` — event payload schema coverage
- `task-012d` — race and lifecycle edge tests
- `task-012e` — error wording + graph performance smoke
- `task-014` — run versus agent nomenclature follow-up

## Important references

- `AGENTS.md` — engineering rules for agents working on this repo.
- `UBIQUITOUS_LANGUAGE.md` — domain terms to preserve in docs, CLI UX, and errors.
- `specs/README.md` — spec index.
- `specs/task-graph.md` — graph inspection and task graph contract.
- `specs/control-plane-supervision.md` — pdx supervision and lifecycle contract.
- `specs/agent-command-reference.md` — implemented command-reference rendering contract.
- `packages/*/README.md` — package-local boundaries and workflows.

## Notes for agents

- Treat [`history.md`](./history.md) as triage input, not acceptance criteria.
- Before claiming a recovered task, re-check current code/tests; some sub-points are already partially covered.
- Do not reintroduce completed task noise to `index.yml`.
