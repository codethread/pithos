import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { buildCli } from "./_helpers/build.ts"
import { runCli } from "./_helpers/exec.ts"

const PKG_DIR = join(import.meta.dirname, "..")
const REPO_ROOT = join(PKG_DIR, "..", "..")
const BIN = join(PKG_DIR, "bin", "pithos-next")
const execFileP = promisify(execFile)
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

  it("enforces supersede scope and lifecycle preconditions and emits minimum supersede events", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScopeA = await upsertRepoScope(env, tempDir, "repo-a")
    const repoScopeB = await upsertRepoScope(env, tempDir, "repo-b")
    const { globalRuns } = await setupRuns(env, tempDir, repoScopeA)

    const claimedTarget = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "claimed target",
      body: "body",
    })
    const claimedRun = await upsertRun(env, {
      agent: "toil",
      scope: "global",
      cwd: tempDir,
      runId: "toil_claimed_target",
    })
    await runOkJson<TaskJson>(
      ["task", "claim", "--run", claimedRun.id, "--scope", "global", "--capability", "triage"],
      env,
    )

    const claimedSupersede = await runCli(
      BIN,
      ["task", "supersede", claimedTarget.id, "--run", globalRuns.toil!, "--reason", "bad claim"],
      env,
    )
    expect(claimedSupersede.exitCode).toBe(1)
    expect(claimedSupersede.stderr).toContain(`Cannot supersede task ${claimedTarget.id} while it is claimed`)

    const runningTarget = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "running target",
      body: "body",
    })
    const runningRun = await upsertRun(env, {
      agent: "toil",
      scope: "global",
      cwd: tempDir,
      runId: "toil_running_target",
    })
    const runningClaim = await runOkJson<TaskJson>(
      ["task", "claim", "--run", runningRun.id, "--scope", "global", "--capability", "triage"],
      env,
    )
    await runOkJson(
      [
        "task",
        "heartbeat",
        "--run",
        runningRun.id,
        "--task",
        runningTarget.id,
        "--token",
        String(runningClaim.task.fencing_token),
      ],
      env,
    )

    const runningSupersede = await runCli(
      BIN,
      ["task", "supersede", runningTarget.id, "--run", globalRuns.toil!, "--reason", "bad running"],
      env,
    )
    expect(runningSupersede.exitCode).toBe(1)
    expect(runningSupersede.stderr).toContain(`Cannot supersede task ${runningTarget.id} while it is running`)

    const scopedTarget = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: repoScopeA,
      capability: "execute",
      title: "scoped target",
      body: "body",
    })
    const dependent = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "cross scope dependent",
      body: "body",
      dependsOn: [scopedTarget.id],
    })

    const crossScopeReject = await runCli(
      BIN,
      [
        "task",
        "supersede",
        scopedTarget.id,
        "--run",
        globalRuns.toil!,
        "--reason",
        "move repos",
        "--scope",
        repoScopeB,
      ],
      env,
    )
    expect(crossScopeReject.exitCode).toBe(1)
    expect(crossScopeReject.stderr).toContain("queued direct dependents would be retargeted across scopes")

    const isolatedTarget = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: repoScopeA,
      capability: "execute",
      title: "isolated target",
      body: "body",
    })
    const isolatedSupersede = await runOkJson<{
      ok: true
      task: { id: string; scope_id: string; capability: string; status: string }
      supersession: { old_task_id: string; new_task_id: string; retargeted_dependent_task_ids: string[] }
    }>(
      [
        "task",
        "supersede",
        isolatedTarget.id,
        "--run",
        globalRuns.toil!,
        "--reason",
        "move without dependents",
        "--scope",
        repoScopeB,
      ],
      env,
    )
    expect(isolatedSupersede.task).toMatchObject({
      scope_id: repoScopeB,
      capability: "execute",
      status: "queued",
    })
    expect(isolatedSupersede.supersession).toMatchObject({
      old_task_id: isolatedTarget.id,
      retargeted_dependent_task_ids: [],
    })

    const eventTail = await runOkJson<{
      ok: true
      events: { task_id: string | null; type: string; payload_json: string }[]
    }>(["events", "tail", "--limit", "20"], env)
    const createdEvent = eventTail.events.find(
      (event) => event.type === "task.created" && event.task_id === isolatedSupersede.task.id,
    )
    expect(createdEvent).toBeDefined()
    expect(JSON.parse(createdEvent!.payload_json)).toMatchObject({
      scope_id: repoScopeB,
      capability: "execute",
      title: "isolated target",
      depends_on_task_ids: [],
      supersedes_task_id: isolatedTarget.id,
    })

    const supersededEvent = eventTail.events.find(
      (event) => event.type === "task.superseded" && event.task_id === isolatedTarget.id,
    )
    expect(supersededEvent).toBeDefined()
    expect(JSON.parse(supersededEvent!.payload_json)).toMatchObject({
      new_task_id: isolatedSupersede.task.id,
      reason: "move without dependents",
      retargeted_dependent_task_ids: [],
    })

    const duplicateSupersede = await runCli(
      BIN,
      [
        "task",
        "supersede",
        isolatedTarget.id,
        "--run",
        globalRuns.toil!,
        "--reason",
        "second replacement should fail",
      ],
      env,
    )
    expect(duplicateSupersede.exitCode).toBe(1)
    expect(duplicateSupersede.stderr).toContain("has already been superseded by")

    const dependentInspect = await runOkJson<{
      ok: true
      task: { unresolved_dependency_ids: string[] }
    }>(["task", "inspect", dependent.id], env)
    expect(dependentInspect.task.unresolved_dependency_ids).toEqual([scopedTarget.id])
  })

  it("requires a non-empty reason for task failure", async () => {
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
      title: "reason required",
      body: "body",
    })
    const claim = await runOkJson<TaskJson>(
      ["task", "claim", "--run", globalRuns.toil!, "--scope", "global", "--capability", "triage"],
      env,
    )

    const missingReason = await runCli(
      BIN,
      [
        "task",
        "fail",
        task.id,
        "--run",
        globalRuns.toil!,
        "--token",
        String(claim.task.fencing_token),
      ],
      env,
    )
    expect(missingReason.exitCode).toBe(2)
    expect(missingReason.stderr).toContain(`Expected to find option: '--reason'`)

    const blankReason = await runCli(
      BIN,
      [
        "task",
        "fail",
        task.id,
        "--run",
        globalRuns.toil!,
        "--token",
        String(claim.task.fencing_token),
        "--reason",
        "   ",
      ],
      env,
    )
    expect(blankReason.exitCode).toBe(2)
    expect(blankReason.stderr).toContain("--reason is required")
  })

  it("emits minimum failure and cancellation event payloads", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScope = await upsertRepoScope(env, tempDir)
    const { globalRuns } = await setupRuns(env, tempDir, repoScope)

    const failedTask = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "failure target",
      body: "body",
    })
    const claim = await runOkJson<TaskJson>(
      ["task", "claim", "--run", globalRuns.toil!, "--scope", "global", "--capability", "triage"],
      env,
    )
    await runOkJson(
      [
        "task",
        "fail",
        failedTask.id,
        "--run",
        globalRuns.toil!,
        "--token",
        String(claim.task.fencing_token),
        "--reason",
        "boom",
      ],
      env,
    )

    const cancelledTask = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: "global",
      capability: "triage",
      title: "cancel target",
      body: "body",
    })
    await runOkJson(
      ["task", "cancel", cancelledTask.id, "--run", globalRuns.toil!, "--reason", "not needed"],
      env,
    )

    const eventTail = await runOkJson<{
      ok: true
      events: { task_id: string | null; type: string; payload_json: string }[]
    }>(["events", "tail", "--limit", "20"], env)

    const failedEvent = eventTail.events.find(
      (event) => event.type === "task.failed" && event.task_id === failedTask.id,
    )
    expect(failedEvent).toBeDefined()
    expect(JSON.parse(failedEvent!.payload_json)).toMatchObject({
      run_id: globalRuns.toil!,
      fencing_token: claim.task.fencing_token,
      reason: "boom",
    })

    const cancelledEvent = eventTail.events.find(
      (event) => event.type === "task.cancelled" && event.task_id === cancelledTask.id,
    )
    expect(cancelledEvent).toBeDefined()
    expect(JSON.parse(cancelledEvent!.payload_json)).toMatchObject({
      reason: "not needed",
    })
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

  it("reclaims active work on run cleanup before max attempts and emits minimum events", async () => {
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
      title: "cleanup reclaim",
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

    const cleanup = await runOkJson<RunJson>(
      ["run", "cleanup", "--run", globalRuns.toil!, "--reason", "process exited"],
      env,
    )
    expect(cleanup.run).toMatchObject({
      id: globalRuns.toil!,
      status: "failed",
      task_id: null,
    })

    const taskInspect = await runOkJson<{
      ok: true
      task: { id: string; status: string; fencing_token: number }
    }>(["task", "inspect", task.id], env)
    expect(taskInspect.task).toMatchObject({
      id: task.id,
      status: "queued",
      fencing_token: claim.task.fencing_token + 1,
    })

    const eventsTail = await runOkJson<{
      ok: true
      events: { type: string; payload_json: string }[]
    }>(["events", "tail", "--limit", "20"], env)
    const reclaimedEvent = eventsTail.events.find((event) => event.type === "task.reclaimed")
    expect(reclaimedEvent).toBeDefined()
    expect(JSON.parse(reclaimedEvent!.payload_json)).toMatchObject({
      previous_run_id: globalRuns.toil!,
      reason: "process exited",
      attempts: 1,
      max_attempts: 3,
      previous_fencing_token: claim.task.fencing_token,
      new_fencing_token: claim.task.fencing_token + 1,
    })
    const cleanupEvent = eventsTail.events.find((event) => event.type === "run.cleanup")
    expect(cleanupEvent).toBeDefined()
    expect(JSON.parse(cleanupEvent!.payload_json)).toMatchObject({
      reason: "process exited",
      previous_status: "running",
      status: "failed",
      task_id: task.id,
    })
  })

  it("dead-letters active work on run cleanup at max attempts", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScope = await upsertRepoScope(env, tempDir)
    const { globalRuns } = await setupRuns(env, tempDir, repoScope)

    let claim: TaskJson | null = null
    let task: TaskJson["task"] | null = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const runId = `toil_cleanup_${attempt}`
      task = task ?? (await enqueueTask(env, {
        runId: globalRuns.toil!,
        scope: "global",
        capability: "triage",
        title: "cleanup dead letter",
        body: "body",
      }))

      await upsertRun(env, {
        agent: "toil",
        scope: "global",
        cwd: tempDir,
        runId,
      })
      claim = await runOkJson<TaskJson>(
        [
          "task",
          "claim",
          "--run",
          runId,
          "--scope",
          "global",
          "--capability",
          "triage",
        ],
        env,
      )
      await runOkJson(
        [
          "run",
          "cleanup",
          "--run",
          runId,
          "--reason",
          `cleanup-${attempt}`,
        ],
        env,
      )
    }

    const taskInspect = await runOkJson<{
      ok: true
      task: { id: string; status: string; fencing_token: number }
    }>(["task", "inspect", task!.id], env)
    expect(taskInspect.task).toMatchObject({
      id: task!.id,
      status: "dead_letter",
      fencing_token: claim!.task.fencing_token + 1,
    })

    const eventsTail = await runOkJson<{
      ok: true
      events: { type: string; payload_json: string }[]
    }>(["events", "tail", "--limit", "40"], env)
    const deadLetterEvent = [...eventsTail.events].reverse().find((event) => event.type === "task.dead_lettered")
    expect(deadLetterEvent).toBeDefined()
    expect(JSON.parse(deadLetterEvent!.payload_json)).toMatchObject({
      previous_run_id: "toil_cleanup_3",
      reason: "cleanup-3",
      attempts: 3,
      max_attempts: 3,
      previous_fencing_token: claim!.task.fencing_token,
      new_fencing_token: claim!.task.fencing_token + 1,
    })
  })

  it("interrupts active work by task lookup and rejects non-held task interrupts", async () => {
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
      title: "interrupt target",
      body: "body",
    })

    const notHeld = await runCli(
      BIN,
      ["run", "interrupt", "--task", task.id, "--reason", "not held"],
      env,
    )
    expect(notHeld.exitCode).toBe(1)
    expect(notHeld.stderr).toContain("Use pithos task cancel")

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

    const interrupted = await runOkJson<RunJson>(
      ["run", "interrupt", "--task", task.id, "--reason", "operator kill"],
      env,
    )
    expect(interrupted.run).toMatchObject({
      id: globalRuns.toil!,
      status: "failed",
      task_id: null,
    })

    const taskInspect = await runOkJson<{
      ok: true
      task: { id: string; status: string; fencing_token: number }
    }>(["task", "inspect", task.id], env)
    expect(taskInspect.task).toMatchObject({
      id: task.id,
      status: "failed",
      fencing_token: claim.task.fencing_token + 1,
    })

    const eventsTail = await runOkJson<{
      ok: true
      events: { type: string; payload_json: string }[]
    }>(["events", "tail", "--limit", "20"], env)
    const interruptedEvent = eventsTail.events.find((event) => event.type === "task.interrupted")
    expect(interruptedEvent).toBeDefined()
    expect(JSON.parse(interruptedEvent!.payload_json)).toMatchObject({
      run_id: globalRuns.toil!,
      reason: "operator kill",
      previous_status: "claimed",
      previous_fencing_token: claim.task.fencing_token,
      new_fencing_token: claim.task.fencing_token + 1,
    })
  })

  it("cleans up idle runs, cancels idle interrupts, and times out no-claim runs", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    await initFresh(env)
    const repoScope = await upsertRepoScope(env, tempDir)
    const { globalRuns } = await setupRuns(env, tempDir, repoScope)

    const cleanup = await runOkJson<RunJson>(
      ["run", "cleanup", "--run", globalRuns.toil!, "--reason", "idle cleanup"],
      env,
    )
    expect(cleanup.run).toMatchObject({ id: globalRuns.toil!, status: "ended", task_id: null })

    await upsertRun(env, { agent: "greed", scope: "global", cwd: tempDir, runId: globalRuns.greed! })
    const idleInterrupt = await runOkJson<RunJson>(
      ["run", "interrupt", "--run", globalRuns.greed!, "--reason", "close idle run"],
      env,
    )
    expect(idleInterrupt.run).toMatchObject({ id: globalRuns.greed!, status: "cancelled", task_id: null })

    const timeoutRun = await upsertRun(env, {
      agent: "war",
      scope: repoScope,
      cwd: join(tempDir, "repo"),
      runId: "war_timeout_repo",
    })
    const timeout = await runOkJson<RunJson>(
      ["run", "timeout", "--run", timeoutRun.id, "--reason", "no claim in 30s"],
      env,
    )
    expect(timeout.run).toMatchObject({ id: timeoutRun.id, status: "timed_out", task_id: null })

    const pandoraTimeout = await runCli(
      BIN,
      ["run", "timeout", "--run", globalRuns.pandora!, "--reason", "should reject"],
      env,
    )
    expect(pandoraTimeout.exitCode).toBe(2)
    expect(pandoraTimeout.stderr).toContain("run timeout excludes pandora")

    const heldTask = await enqueueTask(env, {
      runId: globalRuns.toil!,
      scope: repoScope,
      capability: "execute",
      title: "held timeout reject",
      body: "body",
    })
    const warRun = await upsertRun(env, {
      agent: "war",
      scope: repoScope,
      cwd: join(tempDir, "repo"),
      runId: "war_held_repo",
    })
    await runOkJson<TaskJson>(
      ["task", "claim", "--run", warRun.id, "--scope", repoScope, "--capability", "execute"],
      env,
    )
    const timeoutHeld = await runCli(
      BIN,
      ["run", "timeout", "--run", warRun.id, "--reason", "should reject"],
      env,
    )
    expect(timeoutHeld.exitCode).toBe(2)
    expect(timeoutHeld.stderr).toContain(`Run ${warRun.id} still holds task ${heldTask.id}`)

    const eventsTail = await runOkJson<{
      ok: true
      events: { type: string; payload_json: string }[]
    }>(["events", "tail", "--limit", "40"], env)
    expect(JSON.parse(eventsTail.events.find((event) => event.type === "run.interrupted")!.payload_json)).toMatchObject({
      reason: "close idle run",
      previous_status: "starting",
      status: "cancelled",
    })
    expect(JSON.parse(eventsTail.events.find((event) => event.type === "run.cleanup")!.payload_json)).toMatchObject({
      reason: "idle cleanup",
      previous_status: "starting",
      status: "ended",
    })
    expect(JSON.parse(eventsTail.events.find((event) => event.type === "run.timed_out")!.payload_json)).toMatchObject({
      reason: "no claim in 30s",
      previous_status: "starting",
      status: "timed_out",
    })
  })

  it("runs the documented pithos backbone demo end-to-end", async () => {
    const doc = readFileSync(join(REPO_ROOT, "docs", "demos", "pithos-backbone.md"), "utf-8")
    const match = /```bash\n([\s\S]*?)\n```/.exec(doc)
    expect(match).not.toBeNull()

    const scriptDir = makeTempDir()
    tempDirs.push(scriptDir)
    const scriptPath = join(scriptDir, "pithos-backbone-demo.sh")
    writeFileSync(scriptPath, `${match![1]!}\n`)

    const { stdout, stderr } = await execFileP("bash", [scriptPath], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      encoding: "utf-8",
    })

    const combinedOutput = `${stdout}\n${stderr}`
    expect(combinedOutput).toContain("== init + scope upserts ==")
    expect(combinedOutput).toContain("== enqueue triage / design / execute / escalate ==")
    expect(combinedOutput).toContain("== supersede failed design; queued direct dependents retarget ==")
    expect(combinedOutput).toContain("demo db:")
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
        "war-completion",
        "--title",
        "War report",
        "--body-file",
        reportPath,
      ],
      env,
    )
    expect(artifact.artifact).toMatchObject({
      task_id: task.id,
      run_id: globalRuns.toil!,
      title: "War report",
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
      expect.objectContaining({ kind: "war-completion", title: "War report" }),
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
