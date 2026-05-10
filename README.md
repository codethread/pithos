# Pithos / Pandora control plane

Pandora's Box is a pre-v1 multi-agent orchestration system with three layers:

- **Pithos** — durable task/run/claim/artifact/event state and graph invariants.
- **Spawner** — launcher-only prompt rendering and harness launch metadata.
- **pdx** — local supervisor for process/tmux lifecycle, status, logs, and kill policy.

## Current commands

```sh
pnpm install
pnpm run build
pithos --help
pdx --help
pandora-spawn --help
```

Spawner's CLI is intentionally preview-only:

```sh
pandora-spawn preview \
  --agent war \
  --mode afk \
  --scope scope_repo \
  --run run_demo \
  --session-id session_demo \
  --cwd "$PWD"
```

`pandora-spawn` does not register runs, query Pithos, inject messages, report status, nudge, kill, or clean up lifecycle state. Those policies belong to `pdx` slices.

## Built-in agent roles

| Agent     | Mode source | Claims     | Role                               |
| --------- | ----------- | ---------- | ---------------------------------- |
| `pandora` | manifest    | `escalate` | HITL escalation and Adam decisions |
| `toil`    | manifest    | `triage`   | decomposition and routing          |
| `greed`   | manifest    | `design`   | design briefs and alignment        |
| `war`     | manifest    | `execute`  | repo/worktree execution            |

`pdx` is a system actor for supervisor-authored Pithos mutations; it is not spawnable.

## Docs map

| Path                                 | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `UBIQUITOUS_LANGUAGE.md`             | Shared domain terms                           |
| `specs/control-plane-supervision.md` | Pithos / Spawner / pdx control-plane contract |
| `specs/task-graph.md`                | Dependency and supersession graph semantics   |
| `packages/spawner/README.md`         | Spawner library and preview CLI               |
| `packages/pdx/`                      | Local supervisor package                      |
| `packages/pithos/`                   | Pithos durable state library and CLI          |
