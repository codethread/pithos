import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildCli } from "./_helpers/build.ts"
import { runCli } from "./_helpers/exec.ts"

const PKG_DIR = join(import.meta.dirname, "..")
const BIN = join(PKG_DIR, "bin", "pithos-next")
const AGENTS = ["pdx", "pandora", "toil", "greed", "war"] as const
const CAPABILITIES = ["triage", "design", "execute", "escalate"] as const

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-next-flow-"))
}

function makeEnv(tempDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PITHOS_DB: join(tempDir, "pithos-next.sqlite"),
    PITHOS_LOG_LEVEL: "none",
  }
}

async function runOkJson<T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> {
  const result = await runCli(BIN, args, env)
  expect({ args, stderr: result.stderr }).toMatchObject({ stderr: "" })
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout) as T
}

async function runOkText(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCli(BIN, args, env)
  expect(result.exitCode).toBe(0)
  return result.stdout
}

async function initFresh(env: NodeJS.ProcessEnv): Promise<void> {
  await runOkJson(["init", "--fresh"], env)
}

interface ScopeUpsertJson {
  readonly ok: true
  readonly scope: { readonly id: string }
}

interface RunJson {
  readonly ok: true
  readonly run: {
    readonly id: string
    readonly agent: string
    readonly mode: string
    readonly scope_id: string
    readonly status: string
    readonly task_id: string | null
    readonly session_id: string
    readonly created_at: string
    readonly updated_at: string
  }
}

interface TaskJson {
  readonly ok: true
  readonly task: {
    readonly id: string
    readonly scope_id: string
    readonly capability: string
    readonly status: string
    readonly fencing_token: number
  }
}

async function upsertRepoScope(env: NodeJS.ProcessEnv, tempDir: string, slug = "repo"): Promise<string> {
  const json = await runOkJson<ScopeUpsertJson>(
    ["scope", "upsert", "--kind", "repo", "--path", join(tempDir, slug)],
    env,
  )
  return json.scope.id
}

async function upsertRun(
  env: NodeJS.ProcessEnv,
  args: {
    agent: (typeof AGENTS)[number]
    scope: string
    cwd: string
    runId: string
    mode?: "afk" | "hitl"
  },
): Promise<RunJson["run"]> {
  const json = await runOkJson<RunJson>(
    [
      "run",
      "upsert",
      "--agent",
      args.agent,
      "--mode",
      args.mode ?? "afk",
      "--scope",
      args.scope,
      "--cwd",
      args.cwd,
      "--session-id",
      `${args.runId}_session`,
      "--run",
      args.runId,
    ],
    env,
  )
  return json.run
}

async function enqueueTask(
  env: NodeJS.ProcessEnv,
  args: {
    runId: string
    scope: string
    capability: (typeof CAPABILITIES)[number]
    title: string
    body: string
    dependsOn?: readonly string[]
  },
): Promise<TaskJson["task"]> {
  const cliArgs = [
    "task",
    "enqueue",
    "--run",
    args.runId,
    "--scope",
    args.scope,
    "--capability",
    args.capability,
    "--title",
    args.title,
    "--body",
    args.body,
  ]
  for (const dependencyId of args.dependsOn ?? []) {
    cliArgs.push("--depends-on", dependencyId)
  }
  const json = await runOkJson<TaskJson>(cliArgs, env)
  return json.task
}

async function setupRuns(env: NodeJS.ProcessEnv, tempDir: string, repoScope: string) {
  const globalRuns: Record<string, string> = {}
  const repoRuns: Record<string, string> = {}

  for (const agent of AGENTS) {
    globalRuns[agent] = (
      await upsertRun(env, {
        agent,
        scope: "global",
        cwd: tempDir,
        runId: `${agent}_global`,
      })
    ).id
    repoRuns[agent] = (
      await upsertRun(env, {
        agent,
        scope: repoScope,
        cwd: join(tempDir, "repo"),
        runId: `${agent}_repo`,
      })
    ).id
  }

  return { globalRuns, repoRuns }
}

describe("pithos-next task flow contracts", () => {
  const tempDirs: string[] = []

  beforeAll(async () => {
    await buildCli(PKG_DIR)
  })

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it("rejects every unauthorized enqueue capability combination", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScope = await upsertRepoScope(env, tempDir)
    const { globalRuns } = await setupRuns(env, tempDir, repoScope)

    const allowed = new Map<string, readonly string[]>([
      ["pdx", ["escalate"]],
      ["pandora", ["triage", "design", "escalate"]],
      ["toil", ["triage", "design", "execute", "escalate"]],
      ["greed", ["triage", "design", "escalate"]],
      ["war", ["escalate"]],
    ])

    for (const agent of AGENTS) {
      for (const capability of CAPABILITIES) {
        if (allowed.get(agent)?.includes(capability) === true) {
          continue
        }

        const scope = capability === "execute" ? repoScope : "global"
        const result = await runCli(
          BIN,
          [
            "task",
            "enqueue",
            "--run",
            globalRuns[agent]!,
            "--scope",
            scope,
            "--capability",
            capability,
            "--title",
            `${agent}-${capability}`,
            "--body",
            "body",
          ],
          env,
        )

        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain(`Agent kind ${agent} cannot enqueue capability ${capability}`)
      }
    }
  })

  it("rejects every unauthorized claim capability combination", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScope = await upsertRepoScope(env, tempDir)
    const { globalRuns, repoRuns } = await setupRuns(env, tempDir, repoScope)

    await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "triage task",
      body: "triage body",
    })
    await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "design",
      title: "design task",
      body: "design body",
    })
    await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "escalate",
      title: "escalate task",
      body: "escalate body",
    })
    await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: repoScope,
      capability: "execute",
      title: "execute task",
      body: "execute body",
    })

    const allowed = new Map<string, string>([
      ["pandora", "escalate"],
      ["toil", "triage"],
      ["greed", "design"],
      ["war", "execute"],
    ])

    for (const agent of AGENTS) {
      for (const capability of CAPABILITIES) {
        if (allowed.get(agent) === capability) {
          continue
        }

        const runId = capability === "execute" ? repoRuns[agent]! : globalRuns[agent]!
        const scope = capability === "execute" ? repoScope : "global"
        const result = await runCli(
          BIN,
          [
            "task",
            "claim",
            "--run",
            runId,
            "--scope",
            scope,
            "--capability",
            capability,
          ],
          env,
        )

        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain(`Agent kind ${agent} cannot claim capability ${capability}`)
      }
    }
  })

  it("enforces scope-match and capability-scope validation rules", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScope = await upsertRepoScope(env, tempDir)
    const { globalRuns, repoRuns } = await setupRuns(env, tempDir, repoScope)

    await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "triage task",
      body: "triage body",
    })

    const scopeMismatch = await runCli(
      BIN,
      [
        "task",
        "claim",
        "--run",
        globalRuns.toil!,
        "--scope",
        repoScope,
        "--capability",
        "triage",
      ],
      env,
    )
    expect(scopeMismatch.exitCode).toBe(2)
    expect(scopeMismatch.stderr).toContain("Claim scope mismatch")

    const enqueueEscalateRepo = await runCli(
      BIN,
      [
        "task",
        "enqueue",
        "--run",
        globalRuns.pandora!,
        "--scope",
        repoScope,
        "--capability",
        "escalate",
        "--title",
        "bad escalate",
        "--body",
        "bad",
      ],
      env,
    )
    expect(enqueueEscalateRepo.exitCode).toBe(2)
    expect(enqueueEscalateRepo.stderr).toContain("escalate requires global scope")

    const enqueueExecuteGlobal = await runCli(
      BIN,
      [
        "task",
        "enqueue",
        "--run",
        globalRuns.toil!,
        "--scope",
        "global",
        "--capability",
        "execute",
        "--title",
        "bad execute",
        "--body",
        "bad",
      ],
      env,
    )
    expect(enqueueExecuteGlobal.exitCode).toBe(2)
    expect(enqueueExecuteGlobal.stderr).toContain("execute requires scope kind in {repo, worktree}")

    const claimEscalateRepo = await runCli(
      BIN,
      [
        "task",
        "claim",
        "--run",
        repoRuns.pandora!,
        "--scope",
        repoScope,
        "--capability",
        "escalate",
      ],
      env,
    )
    expect(claimEscalateRepo.exitCode).toBe(2)
    expect(claimEscalateRepo.stderr).toContain("escalate requires global scope")

    const claimExecuteGlobal = await runCli(
      BIN,
      [
        "task",
        "claim",
        "--run",
        globalRuns.war!,
        "--scope",
        "global",
        "--capability",
        "execute",
      ],
      env,
    )
    expect(claimExecuteGlobal.exitCode).toBe(2)
    expect(claimExecuteGlobal.stderr).toContain("execute requires scope kind in {repo, worktree}")
  })

  it("enforces one-held-task-per-run and heartbeat token atomicity", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScope = await upsertRepoScope(env, tempDir)
    const { globalRuns } = await setupRuns(env, tempDir, repoScope)

    const taskA = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "task A",
      body: "body a",
    })
    const taskB = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "task B",
      body: "body b",
    })

    const claimA = await runOkJson<TaskJson>(
      [
        "task",
        "claim",
        "--run",
        globalRuns.toil!,
        "--scope",
        "global",
        "--capability",
        "triage",
      ],
      env,
    )
    expect([taskA.id, taskB.id]).toContain(claimA.task.id)

    const secondClaim = await runCli(
      BIN,
      [
        "task",
        "claim",
        "--run",
        globalRuns.toil!,
        "--scope",
        "global",
        "--capability",
        "triage",
      ],
      env,
    )
    expect(secondClaim.exitCode).toBe(2)
    expect(secondClaim.stderr).toContain("already holds task")

    const missingToken = await runCli(
      BIN,
      ["task", "heartbeat", "--run", globalRuns.toil!, "--task", claimA.task.id],
      env,
    )
    expect(missingToken.exitCode).toBe(2)
    expect(missingToken.stderr).toContain("--task and --token must be supplied together")

    const missingTask = await runCli(
      BIN,
      ["task", "heartbeat", "--run", globalRuns.toil!, "--token", String(claimA.task.fencing_token)],
      env,
    )
    expect(missingTask.exitCode).toBe(2)
    expect(missingTask.stderr).toContain("--task and --token must be supplied together")
  })

  it("rejects superseding done work", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScope = await upsertRepoScope(env, tempDir)
    const { globalRuns } = await setupRuns(env, tempDir, repoScope)

    const task = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "done task",
      body: "done body",
    })
    const claim = await runOkJson<TaskJson>(
      [
        "task",
        "claim",
        "--run",
        globalRuns.toil!,
        "--scope",
        "global",
        "--capability",
        "triage",
      ],
      env,
    )

    await runOkJson(
      [
        "task",
        "complete",
        task.id,
        "--run",
        globalRuns.toil!,
        "--token",
        String(claim.task.fencing_token),
      ],
      env,
    )

    const supersedeDone = await runCli(
      BIN,
      [
        "task",
        "supersede",
        task.id,
        "--run",
        globalRuns.toil!,
        "--reason",
        "should not supersede done work",
      ],
      env,
    )
    expect(supersedeDone.exitCode).toBe(1)
    expect(supersedeDone.stderr).toContain("because it is done")
  })

  it("preserves the old task's dependency provenance after supersede", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScope = await upsertRepoScope(env, tempDir)
    const { globalRuns } = await setupRuns(env, tempDir, repoScope)

    const blocker = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "blocker",
      body: "blocker body",
    })
    const target = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "target",
      body: "target body",
      dependsOn: [blocker.id],
    })
    await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "dependent",
      body: "dependent body",
      dependsOn: [target.id],
    })

    const superseded = await runOkJson<{
      ok: true
      task: { id: string }
      supersession: { old_task_id: string; new_task_id: string; retargeted_dependent_task_ids: string[] }
    }>(
      [
        "task",
        "supersede",
        target.id,
        "--run",
        globalRuns.toil!,
        "--reason",
        "replace middle task",
      ],
      env,
    )
    expect(superseded.supersession.old_task_id).toBe(target.id)

    const oldInspect = await runOkJson<{
      ok: true
      dependencies: { id: string; scope_id: string; status: string; title: string }[]
    }>(["task", "inspect", target.id], env)
    expect(oldInspect.dependencies).toEqual([
      expect.objectContaining({ id: blocker.id }),
    ])
  })

  it("advances claimed work to running idempotently on heartbeat", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScope = await upsertRepoScope(env, tempDir)
    const { globalRuns } = await setupRuns(env, tempDir, repoScope)

    const task = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "heartbeat task",
      body: "body",
    })
    const claim = await runOkJson<TaskJson>(
      [
        "task",
        "claim",
        "--run",
        globalRuns.toil!,
        "--scope",
        "global",
        "--capability",
        "triage",
      ],
      env,
    )
    expect(claim.task.id).toBe(task.id)

    const firstHeartbeat = await runOkJson<TaskJson & { run: { id: string } }>(
      [
        "task",
        "heartbeat",
        "--run",
        globalRuns.toil!,
        "--task",
        task.id,
        "--token",
        String(claim.task.fencing_token),
      ],
      env,
    )
    expect(firstHeartbeat.task.status).toBe("running")

    const secondHeartbeat = await runOkJson<TaskJson & { run: { id: string } }>(
      [
        "task",
        "heartbeat",
        "--run",
        globalRuns.toil!,
        "--task",
        task.id,
        "--token",
        String(claim.task.fencing_token),
      ],
      env,
    )
    expect(secondHeartbeat.task.status).toBe("running")
  })

  it("supports enqueue → claim → heartbeat → artifact → complete round-trip and output contracts", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScope = await upsertRepoScope(env, tempDir)
    const { globalRuns } = await setupRuns(env, tempDir, repoScope)

    const task = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "round trip task",
      body: "triage this work",
    })

    const runInspect = await runOkJson<RunJson>(["run", "inspect", globalRuns.toil!], env)
    expect(runInspect.run).toMatchObject({
      id: globalRuns.toil!,
      agent: "toil",
      mode: "afk",
      scope_id: "global",
      session_id: "toil_global_session",
    })
    expect(runInspect.run.created_at).toBeTypeOf("string")
    expect(runInspect.run.updated_at).toBeTypeOf("string")

    const claim = await runOkJson<TaskJson>(
      [
        "task",
        "claim",
        "--run",
        globalRuns.toil!,
        "--scope",
        "global",
        "--capability",
        "triage",
      ],
      env,
    )
    expect(claim.task.id).toBe(task.id)
    expect(claim.task.status).toBe("claimed")

    await runOkJson(
      [
        "task",
        "heartbeat",
        "--run",
        globalRuns.toil!,
        "--task",
        task.id,
        "--token",
        String(claim.task.fencing_token),
      ],
      env,
    )

    const reportPath = join(tempDir, "report.md")
    writeFileSync(reportPath, "worker completion body")
    const artifact = await runOkJson<{ ok: true; artifact: { task_id: string; run_id: string; title: string } }>(
      [
        "task",
        "artifact",
        "add",
        "--task",
        task.id,
        "--run",
        globalRuns.toil!,
        "--kind",
        "worker-completion",
        "--title",
        "Worker report",
        "--body-file",
        reportPath,
      ],
      env,
    )
    expect(artifact.artifact).toMatchObject({
      task_id: task.id,
      run_id: globalRuns.toil!,
      title: "Worker report",
    })

    const resultPath = join(tempDir, "result.json")
    writeFileSync(resultPath, JSON.stringify({ summary: "done" }))
    const complete = await runOkJson<TaskJson>(
      [
        "task",
        "complete",
        task.id,
        "--run",
        globalRuns.toil!,
        "--token",
        String(claim.task.fencing_token),
        "--result-file",
        resultPath,
      ],
      env,
    )
    expect(complete.task.status).toBe("done")

    const taskInspect = await runOkJson<{
      ok: true
      task: { id: string; status: string; claimable: boolean; unresolved_dependency_ids: string[] }
      dependencies: unknown[]
      dependents: unknown[]
      artifacts: { title: string }[]
    }>(["task", "inspect", task.id], env)
    expect(taskInspect.task).toMatchObject({
      id: task.id,
      status: "done",
      claimable: false,
      unresolved_dependency_ids: [],
    })
    expect(taskInspect.dependencies).toEqual([])
    expect(taskInspect.dependents).toEqual([])
    expect(taskInspect.artifacts).toEqual([
      expect.objectContaining({ title: "Worker report" }),
    ])

    const graphInspect = await runOkJson<{
      ok: true
      graph: { selector: { kind: string; value?: string }; nodes: unknown[]; edges: unknown[] }
    }>(["graph", "inspect", "--task", task.id], env)
    expect(graphInspect.graph.selector).toEqual({ kind: "task", value: task.id })
    expect(graphInspect.graph.nodes.length).toBeGreaterThanOrEqual(1)
    expect(graphInspect.graph.edges).toEqual([])

    const eventsTail = await runOkJson<{ ok: true; count: number; events: { type: string }[] }>(
      ["events", "tail", "--limit", "20"],
      env,
    )
    expect(eventsTail.count).toBeGreaterThan(0)
    expect(eventsTail.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "task.created",
        "task.claimed",
        "task.heartbeat",
        "task.completed",
      ]),
    )

    const briefing = await runOkText(["briefing", "--agent", "pandora"], env)
    expect(briefing).toContain("## Pandora briefing")
    expect(briefing).toContain("### Ready for review")
    expect(briefing).toContain("round trip task")
  })
})
