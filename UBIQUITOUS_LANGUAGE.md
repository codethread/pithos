# Ubiquitous Language

## Control-plane layers

| Term               | Definition                                                                                                | Aliases to avoid                                |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Pithos**         | The durable state system that owns tasks, runs, claims, fencing, artifacts, events, and graph invariants. | DB layer, queue CLI, state CLI                  |
| **Spawner**        | The harness launcher that renders agent prompts and starts AFK processes or HITL tmux sessions.           | Supervisor, control plane, daemon, launcher CLI |
| **pdx**            | The local supervisor that reconciles Pithos state with live processes and tmux sessions.                  | pithosd, daemon, spawner, control-plane CLI     |
| **Registry**       | The in-memory pdx view of currently launching, live, or terminating supervised agents.                    | State store, persisted registry, run table      |
| **Supervisor log** | Structured JSONL records of pdx decisions and OS/tmux outcomes.                                           | Daemon log, unstructured log, transcript        |

## Work graph and chains

| Term                      | Definition                                                                                                                                                                                                                                                                                                                      | Aliases to avoid                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Task graph**            | The full durable relationship map Pithos stores and inspects: tasks, typed Task edges, supersessions, artifacts, runs, and events.                                                                                                                                                                                              | Task chain, workflow, DAG if it obscures product purpose                   |
| **Task chain**            | The work thread the user and agents discuss: the delegation path from initial triage through design, escalation/review, execution, result review, and repair. It is inferred from the Task graph, not stored as its own object.                                                                                                 | Task graph, pipeline if it implies fixed stages, persisted chain object    |
| **Task**                  | A durable unit of queue work in Pithos.                                                                                                                                                                                                                                                                                         | Job, claim, ticket, inbox item                                             |
| **Capability**            | A task category that determines which agent kind may claim the task.                                                                                                                                                                                                                                                            | Skill, stage, recipe step, queue name                                      |
| **Typed Task edge**       | A durable directed relationship from one Task to another. Kinds are `after`, `gate`, `about`, and `repair`.                                                                                                                                                                                                                     | Dependency table, source link, relates_to                                  |
| **after edge**            | A blocking edge: the owner waits until the target Task is `done`, and the owner joins the target's branch closure.                                                                                                                                                                                                              | dependency, prerequisite if it hides edge kind                             |
| **gate edge**             | A blocking coordination edge: the owner waits until the target branch closure drains successfully, but does not join that branch.                                                                                                                                                                                               | review gate, dependency if it hides dynamic branch behavior                |
| **about edge**            | A non-blocking branch-membership edge for immediate Pandora attention/context about target work.                                                                                                                                                                                                                                | source link, provenance side table                                         |
| **repair edge**           | A non-blocking branch-membership edge for a system-authored Repair Alert about broken work. It is repaired by Supersession, replanning, or cancellation, not ordinary continuation.                                                                                                                                             | repair_source, normal context edge                                         |
| **Branch closure**        | The canonical target Task plus all incoming `after`, `about`, and `repair` owners recursively. `gate` edges do not add branch membership.                                                                                                                                                                                       | chain row, static dependency list                                          |
| **Gate release**          | The per-Claim audit snapshot recording that a gated Task started after its target branch closure was clear.                                                                                                                                                                                                                     | approval, permanent unblock                                                |
| **Late branch growth**    | New branch-member work or Supersession under a branch after a gate already released. It fails while downstream impact is non-terminal; terminal-only impact is recorded for inspection.                                                                                                                                         | silent re-open, hidden invalidation                                        |
| **Supersession**          | A replacement edge from a fresh task to the task it replaces while preserving history.                                                                                                                                                                                                                                          | Edit, retry, rewire, resume                                                |
| **Artifact**              | Evidence or output attached to a task or run.                                                                                                                                                                                                                                                                                   | Message, inbox item, notification                                          |
| **Attached context**      | Durable context connected to a task chain for later interrogation without necessarily being a blocking step, such as artifacts, `about`/`repair` edges, or events.                                                                                                                                                              | Edge if it is not a relationship, task if it is not claimable work         |
| **Review task**           | A `review` Capability Task claimed by Greed for requested HITL assessment. It may be global, repo, or worktree scoped; normally it is explicitly requested and `after`-gated like ordinary follow-up work.                                                                                                                      | Escalation, approval status, automatic gate                                |
| **Escalation task**       | A normal global-scope `escalate` capability task claimed by Pandora. Immediate escalations use `about`; checkpoint escalations use `gate`; Repair Alerts use `repair`.                                                                                                                                                          | Escalated status, blocked task, inbox message, review task                 |
| **Checkpoint escalation** | An escalation task with a `gate` edge that becomes claimable only after the target branch drains successfully.                                                                                                                                                                                                                  | Review gate, approval artifact                                             |
| **Repair Alert**          | A system-authored Alert with a typed `kind` indicating the cause of broken/blocked work. Kinds: `interrupt`, `task_failed`, `dead_letter`, `launch_precondition`, `reconciler_stuck`, `kill_failure`, `input_hook_stuck`, `hook_config_error`. Always authored by `run_pdx_system`; affected-task alerts carry a `repair` edge. | interruption escalation, launch-precondition escalation, system escalation |
| **Claimable task**        | A queued task whose `after` targets are `done`, whose `gate` target branches are clear, and whose capability can be claimed by an allowed agent.                                                                                                                                                                                | Open claim, available claim, ready task                                    |
| **Broken chain**          | A task chain blocked by failed, cancelled, or dead-lettered branch work.                                                                                                                                                                                                                                                        | Blocked chain, failed queue                                                |

## Runs

Run terms apply to an agent invocation, not to queue work itself.

| Term              | Definition                                                                                                                                                                                                          | Aliases to avoid                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Run**           | A durable Pithos record for one agent invocation or long-lived session.                                                                                                                                             | Session, process, claim                    |
| **Cleanup**       | The Pithos run transition pdx calls after confirmed natural run/session death; it ends the run and may requeue or dead-letter a held task.                                                                          | Sweep, reclaim, interrupt, run end, finish |
| **Interrupt**     | The Pithos run transition pdx calls when a live run is deliberately stopped. If the run has a held task, that task becomes `failed` and its claim is invalidated; if no task is held, only the run is terminalized. | Cancel, cleanup, reclaim, finish           |
| **Timed out run** | A terminal run state for a non-Pandora no-claim session that exceeded the bootstrap timeout without holding a task.                                                                                                 | Failed task, dead-letter, cleanup          |

## Claims and fencing

| Term              | Definition                                                                         | Aliases to avoid                  |
| ----------------- | ---------------------------------------------------------------------------------- | --------------------------------- |
| **Claim**         | The act of a run taking ownership of one claimable task.                           | Assignment, dequeue, spawn        |
| **Held task**     | The single active task currently pointed to by a run.                              | Active claim, current job         |
| **Fencing token** | A monotonically changing token that invalidates stale task writes from old owners. | Lease token, claim id, auth token |
| **Attempt**       | A count of how many times a task has been claimed.                                 | Retry count, failure count        |

## Task transitions

| Term            | Definition                                                                                                                                                                    | Aliases to avoid                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Cancel**      | The Pithos task transition that intentionally abandons a task that is not currently held by a live run. Use it for queued/failed/dead-lettered work that should not continue. | Interrupt, fail, delete, cleanup |
| **Dead-letter** | A terminal task state reached when retry attempts are exhausted.                                                                                                              | Failed, cancelled, blocked       |

## Agents, harnesses, and supervision modes

| Term                      | Definition                                                                                                                            | Aliases to avoid                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Agent kind**            | A built-in role name that determines claim authorization and template selection.                                                      | Harness, process, worker type, capability                 |
| **Agent run**             | One live or historical invocation of an agent kind, represented by a Pithos run row.                                                  | Agent kind, harness session, process                      |
| **Harness**               | The underlying AI runtime used to execute an agent prompt, such as Claude or Pi.                                                      | Agent, pdx, spawner, tmux                                 |
| **Harness session**       | The runtime session created by a harness, identified by a harness session id and log.                                                 | Run, tmux session, agent kind                             |
| **Control plane**         | The supervision system that observes durable work state and owns live execution resources.                                            | Harness, agent, spawner                                   |
| **Control-plane backend** | The replaceable local execution substrate used by pdx to host interactive agents.                                                     | Harness, agent runtime                                    |
| **Pandora**               | The long-lived HITL agent that claims escalation tasks and works with the user on decisions.                                          | Coordinator if it implies non-claiming, inbox watcher     |
| **Envy**                  | The agent kind that claims intake tasks and routes external signals into triage, design, or escalation work.                          | Worker, implementer                                       |
| **Toil**                  | The agent kind that claims triage tasks and decomposes or routes work.                                                                | Planner, dispatcher                                       |
| **Greed**                 | The HITL agent kind that claims design tasks for design briefs and review tasks for requested assessment.                             | Designer, researcher, reviewer if it hides the Greed role |
| **War**                   | The agent kind that claims execute tasks and performs repo/worktree execution.                                                        | Worker, implementer                                       |
| **AFK mode**              | A supervised headless harness invocation whose process exit is the lifecycle signal.                                                  | Headless worker, subprocess mode                          |
| **HITL mode**             | A supervised tmux-backed harness invocation that may wait for the user.                                                               | Interactive mode, tmux mode                               |
| **No-claim session**      | A live non-Pandora spawned run whose `runs.task_id` is still null before its initial claim; Pandora is excluded because she may idle. | Zombie if HITL waiting is possible, idle claim            |
| **Same-run resurrection** | Recreating a dead process/tmux session with the same run id and claim.                                                                | Restart, resume                                           |
| **Fresh run**             | A new run spawned after the prior run was cleaned up.                                                                                 | Restart if it implies same-run resurrection               |

## Operator actions and naming

| Term              | Definition                                                                                                                                                                                                                                                           | Aliases to avoid                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Open the box**  | Start pdx and the Pandora singleton.                                                                                                                                                                                                                                 | Start Pandora manually, spawn daemon                    |
| **Close the box** | Stop pdx and clean up all supervised runs and sessions.                                                                                                                                                                                                              | Kill daemon if it implies no cleanup                    |
| **Kill**          | A pdx operator action that interrupts Pithos state first and then kills the live process or tmux session.                                                                                                                                                            | Restart, cleanup, cancel                                |
| **Alert**         | A system-authored durable record that the control plane or durable state has hit an anomaly needing human attention. Implemented as a global-scope `escalate` task authored by the pdx system actor. Durable, survives pdx restart, recoverable from the task graph. | System escalation, harness alert                        |
| **Nudge**         | A best-effort, content-free signal from the control plane to a live harness session via the **Control-plane backend**. Always paired with durable Pithos state.                                                                                                      | Wakeup, message injection, nudge-with-body, tmux marker |
| **Logical name**  | A friendly pdx-owned name for a supervised entry, using the `pdx--...` convention.                                                                                                                                                                                   | Session id, run id                                      |
| **tmux target**   | The current control-plane backend address for a HITL agent.                                                                                                                                                                                                          | Harness session, logical name if used for AFK too       |

## Relationships

- A **Task graph** is the durable interrogation model; a **Task chain** is a work thread reconstructed from that graph.
- A **Task chain** is not a separate table or object. It is inferred from typed Task edges, Supersessions, Artifacts, runs, and events.
- `after` and `gate` edges gate claimability; `about` and `repair` do not gate their owner but do add branch membership.
- A **Run** may hold at most one **Held task** at a time.
- A **Run** may make multiple sequential **Claims** after each prior **Held task** is completed, failed, interrupted, or cleaned up.
- A **Task** has exactly one **Capability**.
- An **Agent kind** may claim zero or more **Capabilities**, enforced by Pithos seeded claim rules.
- The seeded **pdx** system actor is an **Agent kind** for durable authorship only; it is not spawnable and has no claims.
- All **Escalation tasks** live in global scope. A **Review task** is ordinary non-escalation work claimed by **Greed** and may live in global, repo, or worktree scope.
- A normal attention **Escalation task** uses `about` so **Pandora** can route the chain without waiting on the target.
- A **Checkpoint escalation** uses `gate` so **Pandora** sees it only after the target branch drains successfully.
- A **Repair Alert** uses `repair`; **Pandora** should repair it with **Supersession**, explicit replanning, or intentional cancellation, not ordinary chain continuation.
- **pdx** uses the **Spawner** to launch **Agent runs** and owns **Run** finalization, **Cleanup**, **Interrupt**, and **Kill** policy.
- **Spawner** translates an **Agent kind** plus launch context into a **Harness session**.
- A **Harness** runs prompts and writes session logs; it does not own Pithos graph policy or control-plane placement.
- The **Control plane** is `pdx` plus Pithos state transitions plus the selected **Control-plane backend**, not the **Harness** itself.
- **tmux** is the current **Control-plane backend** for HITL agents and may be replaced without changing harness semantics.
- **Pandora** is a normal claiming agent for **Escalation tasks**, not a separate artifact inbox.
- **Cleanup** is for confirmed natural death; **Interrupt** is for deliberate **Kill** of a live run; **Cancel** is for intentionally abandoning a non-held task.
- **Kill** mutates Pithos with **Interrupt** before killing OS/tmux resources.
- A dead agent is never resurrected as the same **Run**; normal reconcile may create a **Fresh run**.
- Agents and harness hooks complete/fail **Held tasks** and exit; they do not finalize **Runs**.
- pdx calls **Cleanup** only after it has observed or confirmed that the **Agent run** execution resource is gone.
- A non-Pandora **No-claim session** that exceeds the bootstrap timeout becomes a **Timed out run**; no **Task** is mutated.
- **Interrupt** acts on a **Run** and may mutate its **Held task**; **Cancel** acts on a **Task** that is not actively held.
- If **pdx** finds a **Claimable task** whose repo/worktree runtime path no longer exists before run creation, no **Run** is created. If that path disappears after a run row is created but before launch succeeds, **pdx** terminalizes the no-claim **Run** before repairing the queued task. In both cases **pdx** uses **Cancel** on the queued task and creates a **Repair Alert** for **Pandora** to repair with **Supersession** or replanning.

## Example dialogue

> **Dev:** "If **War** goes off the rails while holding an `execute` **Task**, do we just requeue the task?"
>
> **Domain expert:** "No. A deliberate **Kill** uses **Interrupt**, so the **Held task** becomes `failed`, its **Fencing token** is incremented, and the engine creates a **Repair Alert** with a `repair` edge for **Pandora**. Use **Interrupt** because a live **Run** is involved."
>
> **Dev:** "What if Pandora decides a queued follow-up task is no longer needed?"
>
> **Domain expert:** "That is **Cancel**. No live **Run** owns the task; we are intentionally abandoning planned work, not stopping an agent."
>
> **Dev:** "Does that escalation wait for the failed task?"
>
> **Domain expert:** "No. Failed work will not satisfy `after`, so a **Repair Alert** references it with `repair` and stays immediately claimable."

## Flagged ambiguities

- "Graph" and "chain" were used interchangeably; use **Task graph** for the complete durable relationship model and **Task chain** for the delegation thread reconstructed from it.
- "Chain" should not imply a separate persisted object, a fixed stage pipeline, or a purely linear history.
- "Dependency", "Source link", `chain_source`, and `repair_source` are retired as durable primitives. Use typed Task edges: `after`, `gate`, `about`, `repair`.
- "Claim" was used to mean both the act of taking a task and the task itself; use **Claim** for the act and **Task** or **Claimable task** for the work item.
- "Blocked" conflicts with dependency blockage and proposed human-attention states; use **Escalation task** for Pandora attention and **Broken chain** for dependency/gate blockage.
- "Restart" was ambiguous between **Same-run resurrection** and spawning a **Fresh run** after **Cleanup**; avoid "restart" unless explicitly qualified.
- "Kill", "Interrupt", "Cancel", and "Cleanup" were conflated; use **Kill** for the pdx operator action, **Interrupt** for the Pithos transition behind a live run stop, **Cancel** for abandoning non-held tasks, and **Cleanup** for confirmed natural lifecycle death.
- "Wakeup" is retired; use **Nudge** plus a typed `reason` field.
- "Spawner" was overloaded as launcher and supervisor; use **Spawner** only for harness launch, and **pdx** for supervision and Run finalization.
- "Coordinator" under-described Pandora because she claims work; call **Pandora** a long-lived HITL agent that consumes **Escalation tasks**.
- "Agent" can mean a role, a live invocation, or the underlying model runtime; use **Agent kind** for the role, **Agent run** or **Run** for the invocation, and **Harness** for Claude/Pi.
- "Capability" was confused with recipe stages such as execute/run/watch; use **Capability** only for claim authorization categories seeded in Pithos.
