# Evils & Claims

The Pithos agent roster, their capabilities, and how work routes through the system.

## Agent roster

| Agent    | Type   | Claims      | Tools                    | CWD          | Role                                          |
|----------|--------|-------------|--------------------------|--------------|-----------------------------------------------|
| Pandora  | AFK    | —           | Bash, Read, Grep, Glob   | `~/.pandora` | Global orchestrator. Delegates, never does.   |
| Toil     | AFK    | `triage`    | Bash, Read, Grep, Glob   | caller-cwd   | Breaks down goals, finds repos, enqueues.     |
| Envy     | AFK    | `implement` | Bash, Read, Grep, Glob   | caller-cwd   | Watcher. Spawns workers, monitors, reports.   |
| Greed    | HITL   | `design`    | TBD                      | caller-cwd   | Design partner. Research + discussion w/ Adam.|

## Delegation chain

```
Adam
 │  "migrate the pithos spawner to Effect"
 ▼
Pandora ─── orchestrates, never mutates
 │  if scope unknown: spawns Toil in ~/.pandora to break it down
 │  if scope known from Adam's brief: goes straight to per-repo Toil
 ▼
Toil (breakdown, optional) ─── explores filesystem, finds repos, briefs Pandora
 │  artifact / enqueue briefing back to Pandora
 ▼
Pandora ─── spawns per-repo Toils
 │
 ▼
Toil (per-repo) ─── enqueues implement/design tasks into each scope
 │
 ▼
Envy ─── claims implement, spawns workers, watches, reports
 │
 ▼
Workers ─── do the actual mutation
```

## Claim routing

Each capability has exactly one claimant. Tasks flow to the right agent automatically via `pithos claim --capability <cap>`.

```
pithos enqueue --capability triage     ──→  Toil claims
pithos enqueue --capability implement  ──→  Envy claims
pithos enqueue --capability design     ──→  Greed claims
```

Pandora never claims — she coordinates across all capabilities.

## Per-agent detail

### Pandora — orchestrator

**Does not claim tasks.** Pandora receives high-level goals from Adam and delegates.

If Adam's brief already names a scope, Pandora goes straight to per-repo Toil. If the scope is unknown, she spawns a breakdown Toil in `~/.pandora` first.

Her only mutation is her own workspace (`~/.pandora`). She does not break down goals herself — that's Toil's job. She does not monitor workers — that's Envy's job.

**How Pandora sees state** (the Pithos DB is her memory):
- `pithos briefing --agent <agent>` — recent activity per agent, with task outcomes and artifacts
- `pithos inspect task <id>` — full task detail, its run, and attached artifacts
- `pithos inspect run <id>` — run state, session, parent chain
- `pithos tail` — recent events across all scopes
- `pandora-spawn status --session-id <id>` — live agent session transcript tail
- Artifacts (`worker-completion`, custom) are her primary result format — agents attach them before completing

### Toil — decomposer

**Claims `triage`.** Two modes:

1. **Breakdown** (in `~/.pandora`): Explores the filesystem to find relevant repos for a high-level goal. Briefs Pandora back via artifact or enqueue. Does not implement.
2. **Per-repo triage** (in a repo scope): Breaks work into concrete tasks, enqueues them with the right capability, then finalizes.

Toil exists because breaking down a goal and discovering repos was eating Pandora's context.

### Envy — watcher

**Claims `implement`.** Picks up actionable tasks, spawns workers to do the mutation, monitors them, restarts stuck workers, handles context resets, and reports back. Does not mutate the repo herself — workers do. Attaches `worker-completion` artifacts before task completion.

Envy exists because Pandora was burning context babysitting individual workers through long-running tasks.

### Greed — design partner

**Claims `design`.** HITL (human-in-the-loop). Picks up design/research tasks and conducts detailed analysis with Adam. Not yet implemented.

## Why this indirection?

Each agent has a narrow job that fits in a single Claude Code context window. The delegation chain is deliberate:

- **Pandora** can't break down tasks (costly context, scope discovery) → **Toil**
- **Pandora** can't babysit workers (context resets, timeouts, restarts) → **Envy**
- **Envy** can't mutate repos (fencing tokens, stale leases) → **Workers**

Every handoff uses the Pithos DB as the shared memory — tasks, artifacts, and run state survive context resets.
