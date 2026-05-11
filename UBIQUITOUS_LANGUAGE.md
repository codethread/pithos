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

| Term                        | Definition                                                                                                                                                    | Aliases to avoid                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Task graph**              | The full durable relationship map Pithos stores and inspects: tasks, dependencies, source links, supersessions, artifacts, runs, and events.                  | Task chain, workflow, DAG if it obscures the product purpose                    |
| **Task chain**              | The work thread Adam and agents discuss: the delegation path from initial triage through design, escalation/review, execution, result review, and repair.     | Task graph, pipeline if it implies fixed stages, persisted chain object         |
| **Task**                    | A durable unit of queue work in Pithos.                                                                                                                       | Job, claim, ticket, inbox item                                                  |
| **Capability**              | A task category that determines which agent kind may claim the task.                                                                                          | Skill, stage, recipe step, queue name                                           |
| **Dependency**              | A blocking graph edge meaning the upstream task must be `done` before the downstream task is claimable.                                                       | Blocker link, parent, prerequisite if it implies non-success states can satisfy |
| **Source link**             | A non-blocking provenance edge meaning this task is about, or came from, a source task. It helps reconstruct the chain but does not affect claimability.      | relates_to, dependency, parent, blocker                                         |
| **Supersession**            | A replacement edge from a fresh task to the task it replaces while preserving history.                                                                        | Edit, retry, rewire, resume                                                     |
| **Artifact**                | Evidence or output attached to a task or run.                                                                                                                 | Message, inbox item, notification                                               |
| **Attached context**        | Durable context connected to a task chain for later interrogation without necessarily being a blocking task step, such as artifacts, source links, or events. | Edge if it is not a relationship, task if it is not claimable work              |
| **Escalation task**         | A normal global-scope `escalate` capability task that routes attention to Pandora.                                                                            | Escalated status, blocked task, inbox message, nudge                            |
| **Checkpoint escalation**   | An escalation task that depends on successful prior work and becomes claimable only after that work is `done`.                                                | Review gate, approval artifact                                                  |
| **Interruption escalation** | A global escalation task that references a failed/interrupted task without depending on it.                                                                   | Failure dependency, blocked escalation                                          |
| **Claimable task**          | A queued task whose dependencies are all `done` and whose capability can be claimed by an allowed agent.                                                      | Open claim, available claim, ready task                                         |
| **Broken chain**            | A task chain blocked by a failed, cancelled, or dead-lettered dependency.                                                                                     | Blocked chain, failed queue                                                     |

## Runs

Run terms apply to an agent invocation, not to queue work itself.

| Term              | Definition                                                                                                                                                                                                          | Aliases to avoid                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Run**           | A durable Pithos record for one agent invocation or long-lived session.                                                                                                                                             | Session, process, claim                    |
| **Cleanup**       | The Pithos run transition pdx calls after confirmed natural run/session death; it ends the run and may requeue or dead-letter a held task.                                                                          | Sweep, reclaim, interrupt, run end, finish |
| **Interrupt**     | The Pithos run transition pdx calls when a live run is deliberately stopped. If the run has a held task, that task becomes `failed` and its claim is invalidated; if no task is held, only the run is terminalized. | Cancel, cleanup, reclaim, finish           |
| **Timed out run** | A terminal run state for a non-Pandora no-claim session that exceeded the bootstrap timeout without holding a task.                                                                                                 | Failed task, dead-letter, cleanup          |

## Claims and fencing

Claim terms describe the relationship between a run and a task.

| Term              | Definition                                                                         | Aliases to avoid                  |
| ----------------- | ---------------------------------------------------------------------------------- | --------------------------------- |
| **Claim**         | The act of a run taking ownership of one claimable task.                           | Assignment, dequeue, spawn        |
| **Held task**     | The single active task currently pointed to by a run.                              | Active claim, current job         |
| **Fencing token** | A monotonically changing token that invalidates stale task writes from old owners. | Lease token, claim id, auth token |
| **Attempt**       | A count of how many times a task has been claimed.                                 | Retry count, failure count        |

## Task transitions

Task transitions apply to queue work, not to the live agent run.

| Term            | Definition                                                                                                                                                                    | Aliases to avoid                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Cancel**      | The Pithos task transition that intentionally abandons a task that is not currently held by a live run. Use it for queued/failed/dead-lettered work that should not continue. | Interrupt, fail, delete, cleanup |
| **Dead-letter** | A terminal task state reached when retry attempts are exhausted.                                                                                                              | Failed, cancelled, blocked       |

## Agents, harnesses, and supervision modes

| Term                      | Definition                                                                                                                            | Aliases to avoid                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Agent kind**            | A built-in role name that determines claim authorization and template selection.                                                      | Harness, process, worker type, capability             |
| **Agent run**             | One live or historical invocation of an agent kind, represented by a Pithos run row.                                                  | Agent kind, harness session, process                  |
| **Harness**               | The underlying AI runtime used to execute an agent prompt, such as Claude or Pi.                                                      | Agent, pdx, spawner, tmux                             |
| **Harness session**       | The runtime session created by a harness, identified by a harness session id and log.                                                 | Run, tmux session, agent kind                         |
| **Control plane**         | The supervision system that observes durable work state and owns live execution resources.                                            | Harness, agent, spawner                               |
| **Control-plane backend** | The replaceable local execution substrate used by pdx to host interactive agents.                                                     | Harness, agent runtime                                |
| **Pandora**               | The long-lived HITL agent that claims escalation tasks and works with Adam on decisions.                                              | Coordinator if it implies non-claiming, inbox watcher |
| **Toil**                  | The agent kind that claims triage tasks and decomposes or routes work.                                                                | Planner, dispatcher                                   |
| **Greed**                 | The agent kind that claims design tasks and produces design briefs.                                                                   | Designer, researcher                                  |
| **War**                   | The agent kind that claims execute tasks and performs repo/worktree execution.                                                        | Worker, implementer, Envy                             |
| **AFK mode**              | A supervised headless harness invocation whose process exit is the lifecycle signal.                                                  | Headless worker, subprocess mode                      |
| **HITL mode**             | A supervised tmux-backed harness invocation that may wait for Adam.                                                                   | Interactive mode, tmux mode                           |
| **No-claim session**      | A live non-Pandora spawned run whose `runs.task_id` is still null before its initial claim; Pandora is excluded because she may idle. | Zombie if HITL waiting is possible, idle claim        |
| **Same-run resurrection** | Recreating a dead process/tmux session with the same run id and claim.                                                                | Restart, resume                                       |
| **Fresh run**             | A new run spawned after the prior run was cleaned up.                                                                                 | Restart if it implies same-run resurrection           |

## Operator actions and naming

| Term              | Definition                                                                                                | Aliases to avoid                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Open the box**  | Start pdx and the Pandora singleton.                                                                      | Start Pandora manually, spawn daemon                       |
| **Close the box** | Stop pdx and clean up all supervised runs and sessions.                                                   | Kill daemon if it implies no cleanup                       |
| **Kill**          | A pdx operator action that interrupts Pithos state first and then kills the live process or tmux session. | Restart, cleanup, cancel                                   |
| **Wakeup**        | A content-free `tmux send-keys` marker to live Pandora that claimable escalation work exists.             | Nudge if it implies task body injection, message injection |
| **Logical name**  | A friendly pdx-owned name for a supervised entry, using the `pdx--...` convention.                        | Session id, run id                                         |
| **tmux target**   | The current control-plane backend address for a HITL agent.                                               | Harness session, logical name if used for AFK too          |

## Relationships

- A **Task graph** is the durable interrogation model; a **Task chain** is a work thread reconstructed from that graph.
- A **Task chain** is not a separate table or object. It is inferred from **Dependencies**, **Source links**, **Supersessions**, **Artifacts**, runs, and events.
- A **Dependency** and a **Source link** can both connect work into a **Task chain**, but only a **Dependency** gates whether a downstream **Task** is claimable.
- A **Run** may hold at most one **Held task** at a time.
- A **Run** may make multiple sequential **Claims** after each prior **Held task** is completed, failed, interrupted, or cleaned up.
- A **Task** has exactly one **Capability**.
- An **Agent kind** may claim zero or more **Capabilities**, enforced by Pithos seeded claim rules.
- The seeded **pdx** system actor is an **Agent kind** for durable authorship only; it is not spawnable and has no claims.
- A **Dependency** is satisfied only when the upstream **Task** is `done`.
- A **Supersession** replaces one **Task** with exactly one fresh replacement task.
- All **Escalation tasks** live in global scope. A **Checkpoint escalation** depends on successful prior work; an **Interruption escalation** references failed work without depending on it.
- A normal attention **Escalation task** may carry a **Source link** to the task it is about so **Pandora** can route the chain onward without making the escalation wait on that source.
- **pdx** uses the **Spawner** to launch **Agent runs** and is the only owner of **Run** finalization, **Cleanup**, **Interrupt**, and **Kill** policy.
- **Spawner** translates an **Agent kind** plus launch context into a **Harness session**.
- A **Harness** runs prompts and writes session logs; it does not own Pithos graph policy or control-plane placement.
- The **Control plane** is `pdx` plus Pithos state transitions plus the selected **Control-plane backend**, not the **Harness** itself.
- **tmux** is the current **Control-plane backend** for HITL agents and may be replaced without changing harness semantics.
- **Spawner** may create a **tmux target** as launch metadata, but `pdx` owns its lifecycle.
- **Pandora** is a normal claiming agent for **Escalation tasks**, not a separate artifact inbox.
- **Cleanup** is for confirmed natural death; **Interrupt** is for deliberate **Kill** of a live run; **Cancel** is for intentionally abandoning a non-held task.
- **Kill** mutates Pithos with **Interrupt** before killing OS/tmux resources.
- A dead agent is never resurrected as the same **Run**; normal reconcile may create a **Fresh run**.
- Agents and harness hooks complete/fail **Held tasks** and exit; they do not finalize **Runs**.
- pdx calls **Cleanup** only after it has observed or confirmed that the **Agent run** execution resource is gone.
- A non-Pandora **No-claim session** that exceeds the bootstrap timeout becomes a **Timed out run**; no **Task** is mutated.
- **Interrupt** acts on a **Run** and may mutate its **Held task**; **Cancel** acts on a **Task** that is not actively held.

## Example dialogue

> **Dev:** "If **War** goes off the rails while holding an `execute` **Task**, do we just requeue the task?"
>
> **Domain expert:** "No. A deliberate **Kill** uses **Interrupt**, so the **Held task** becomes `failed`, its **Fencing token** is incremented, and pdx creates an **Interruption escalation** for **Pandora**. Use **Interrupt** because a live **Run** is involved."
>
> **Dev:** "What if Pandora decides a queued follow-up task is no longer needed?"
>
> **Domain expert:** "That is **Cancel**. No live **Run** owns the task; we are intentionally abandoning planned work, not stopping an agent."
>
> **Dev:** "Does that escalation depend on the failed task?"
>
> **Domain expert:** "No. A **Dependency** only unblocks on `done`, so an **Interruption escalation** references the failed task without depending on it."
>
> **Dev:** "How does work continue after Pandora reviews it?"
>
> **Domain expert:** "Pandora can ask **Toil** to repair the **Broken chain** with a **Supersession**. Queued direct dependents move to the fresh replacement task, and future agents claim from the repaired chain."
>
> **Dev:** "And if **Greed** just exits unexpectedly?"
>
> **Domain expert:** "That is natural death, so pdx calls **Cleanup**. The old **Run** is not resurrected; reconcile may spawn a **Fresh run** if a **Claimable task** remains."

## Flagged ambiguities

- "Graph" and "chain" were used interchangeably; use **Task graph** for the complete durable relationship model and **Task chain** for the delegation thread reconstructed from it.
- "Chain" should not imply a separate persisted object, a fixed stage pipeline, or a purely linear history. It is the product-facing story of related work.
- "Source" and "relates_to" were candidates for non-blocking provenance. Use **Source link** because it is directional and specific: this task came from or is about that source task. Avoid `relates_to` until there is a real typed-relation system.
- "Claim" was used to mean both the act of taking a task and the task itself; use **Claim** for the act and **Task** or **Claimable task** for the work item.
- "Blocked" conflicts with dependency blockage and proposed human-attention states; use **Escalation task** for Pandora attention and **Broken chain** for dependency blockage.
- "Restart" was ambiguous between **Same-run resurrection** and spawning a **Fresh run** after **Cleanup**; avoid "restart" unless explicitly qualified.
- "Kill", "Interrupt", "Cancel", and "Cleanup" were conflated; use **Kill** for the pdx operator action, **Interrupt** for the Pithos transition behind a live run stop, **Cancel** for abandoning non-held tasks, and **Cleanup** for confirmed natural lifecycle death.
- "Nudge" previously meant prompt/message injection; use **Wakeup** for content-free notification and avoid **nudge** in the new control plane.
- "Spawner" was overloaded as launcher and supervisor; use **Spawner** only for harness launch, and **pdx** for supervision and Run finalization.
- "Coordinator" under-described Pandora because she claims work; call **Pandora** a long-lived HITL agent that consumes **Escalation tasks**.
- "Agent" can mean a role, a live invocation, or the underlying model runtime; use **Agent kind** for the role, **Agent run** or **Run** for the invocation, and **Harness** for Claude/Pi.
- "Capability" was confused with recipe stages such as execute/run/watch; use **Capability** only for claim authorization categories seeded in Pithos.
