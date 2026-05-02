/**
 * Tests for Slice 11: Attach a worker completion artifact.
 *
 * Layers:
 *  1. Unit  — validation with fake DB/FS service
 *  2. Integration — real SQLite in temp dir
 *  3. parseArgs  — artifact:add routing
 *  4. CLI process — smoke tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync, spawnSync } from "node:child_process"
import Database from "better-sqlite3"

import { artifactAddCommand } from "../src/commands/artifact.ts"
import { inspectTaskCommand } from "../src/commands/inspect.ts"
import { enqueueCommand } from "../src/commands/enqueue.ts"
import { runRegisterCommand } from "../src/commands/run.ts"
import { parseArgs } from "../src/cli/args.ts"
import { makeDbServiceLive, makeDbServiceTest } from "../src/layers/db.ts"
import { makeIdServiceTest } from "../src/layers/ids.ts"
import { FsServiceLive, makeFsServiceTest } from "../src/layers/fs.ts"
import { initCommand } from "../src/commands/init.ts"
import { makeOutputServiceSilent, makeOutputServiceTest } from "../src/layers/output.ts"

const silentOutput = makeOutputServiceSilent()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BIN = join(import.meta.dirname, "../bin/pithos")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-artifact-"))
}

async function runEff<A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect)
}

// ---------------------------------------------------------------------------
// 1. Unit — fake DB / validation only
// ---------------------------------------------------------------------------

describe("artifactAddCommand (unit — fake DB)", () => {
  const fakeLayer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest([]), makeFsServiceTest(), silentOutput)

  it("fails VALIDATION_ERROR when --task is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        artifactAddCommand({
          task: undefined,
          run: "run_abc",
          kind: "worker-completion",
          title: "Report",
          bodyFile: undefined,
        }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --run is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        artifactAddCommand({
          task: "task_abc",
          run: undefined,
          kind: "worker-completion",
          title: "Report",
          bodyFile: undefined,
        }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --kind is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        artifactAddCommand({
          task: "task_abc",
          run: "run_abc",
          kind: undefined,
          title: "Report",
          bodyFile: undefined,
        }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails VALIDATION_ERROR when --title is missing", async () => {
    const exit = await runEff(
      Effect.provide(
        artifactAddCommand({
          task: "task_abc",
          run: "run_abc",
          kind: "worker-completion",
          title: undefined,
          bodyFile: undefined,
        }),
        fakeLayer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fails NOT_FOUND when --body-file does not exist", async () => {
    const layer = Layer.mergeAll(makeDbServiceTest(), makeIdServiceTest([]), makeFsServiceTest(), silentOutput)
    const exit = await runEff(
      Effect.provide(
        artifactAddCommand({
          task: "task_abc",
          run: "run_abc",
          kind: "worker-completion",
          title: "Report",
          bodyFile: "/nonexistent/report.md",
        }),
        layer,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Integration — real SQLite
// ---------------------------------------------------------------------------

describe("artifactAddCommand (integration — real SQLite)", () => {
  let tempDir: string
  let dbPath: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    dbLayer = makeDbServiceLive(dbPath)
    await Effect.runPromise(Effect.provide(initCommand, Layer.merge(dbLayer, silentOutput)))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const enqueue = async (taskId: string): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([taskId]), FsServiceLive, silentOutput)
    await Effect.runPromise(
      Effect.provide(
        enqueueCommand({ scope: "global", capability: "watch", title: `Task ${taskId}` }),
        layer,
      ),
    )
    return taskId
  }

  const registerRun = async (runId: string): Promise<string> => {
    const layer = Layer.mergeAll(dbLayer, makeIdServiceTest([runId]), FsServiceLive, silentOutput)
    await Effect.runPromise(
      Effect.provide(runRegisterCommand({ agentKind: "envy", run: runId }), layer),
    )
    return runId
  }

  it("inserts an artifact row and returns ok:true", async () => {
    const taskId = await enqueue("task_art1")
    const runId = await registerRun("run_art1")

    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(
        artifactAddCommand({
          task: taskId,
          run: runId,
          kind: "worker-completion",
          title: "Worker report",
          bodyFile: undefined,
        }),
        Layer.mergeAll(dbLayer, makeIdServiceTest(["artifact_art1"]), FsServiceLive, out.layer),
      ),
    )

    expect(out.lines()).toHaveLength(1)
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      artifact: { id: string; kind: string; title: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.artifact.id).toBe("artifact_art1")
    expect(parsed.artifact.kind).toBe("worker-completion")
    expect(parsed.artifact.title).toBe("Worker report")
  })

  it("reads body from --body-file when provided", async () => {
    const taskId = await enqueue("task_art_body")
    const runId = await registerRun("run_art_body")

    const reportPath = join(tempDir, "report.md")
    const reportContent = "## Worker report\n\nAll tasks complete."
    writeFileSync(reportPath, reportContent)

    await Effect.runPromise(
      Effect.provide(
        artifactAddCommand({
          task: taskId,
          run: runId,
          kind: "worker-completion",
          title: "Report",
          bodyFile: reportPath,
        }),
        Layer.mergeAll(dbLayer, makeIdServiceTest(["artifact_art_body"]), FsServiceLive, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT body FROM artifacts WHERE id = ?")
      .get("artifact_art_body") as { body: string }
    db.close()

    expect(row.body).toBe(reportContent)
  })

  it("stores empty body when --body-file is omitted", async () => {
    const taskId = await enqueue("task_art_nobody")
    const runId = await registerRun("run_art_nobody")

    await Effect.runPromise(
      Effect.provide(
        artifactAddCommand({
          task: taskId,
          run: runId,
          kind: "design-brief",
          title: "Brief",
          bodyFile: undefined,
        }),
        Layer.mergeAll(dbLayer, makeIdServiceTest(["artifact_art_nobody"]), FsServiceLive, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const row = db
      .prepare("SELECT body FROM artifacts WHERE id = ?")
      .get("artifact_art_nobody") as { body: string }
    db.close()

    expect(row.body).toBe("")
  })

  it("inspect task includes artifacts array with added artifact", async () => {
    const taskId = await enqueue("task_art_inspect")
    const runId = await registerRun("run_art_inspect")

    // Add artifact
    await Effect.runPromise(
      Effect.provide(
        artifactAddCommand({
          task: taskId,
          run: runId,
          kind: "worker-completion",
          title: "Completion report",
          bodyFile: undefined,
        }),
        Layer.mergeAll(dbLayer, makeIdServiceTest(["artifact_inspect1"]), FsServiceLive, silentOutput),
      ),
    )

    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(inspectTaskCommand(taskId), Layer.merge(dbLayer, out.layer)),
    )

    expect(out.lines()).toHaveLength(1)
    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      task: { id: string }
      artifacts: { id: string; kind: string; title: string }[]
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.task.id).toBe(taskId)
    expect(parsed.artifacts).toHaveLength(1)
    expect(parsed.artifacts[0]!.id).toBe("artifact_inspect1")
    expect(parsed.artifacts[0]!.kind).toBe("worker-completion")
    expect(parsed.artifacts[0]!.title).toBe("Completion report")
  })

  it("inspect task shows empty artifacts array when no artifacts added", async () => {
    const taskId = await enqueue("task_art_empty")

    const out = makeOutputServiceTest()
    await Effect.runPromise(
      Effect.provide(inspectTaskCommand(taskId), Layer.merge(dbLayer, out.layer)),
    )

    const parsed = JSON.parse(out.lines()[0]!) as {
      ok: boolean
      artifacts: unknown[]
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.artifacts).toHaveLength(0)
  })

  it("multiple artifacts on same task are all returned", async () => {
    const taskId = await enqueue("task_art_multi")
    const runId = await registerRun("run_art_multi")

    await Effect.runPromise(
      Effect.provide(
        artifactAddCommand({
          task: taskId,
          run: runId,
          kind: "worker-completion",
          title: "First report",
          bodyFile: undefined,
        }),
        Layer.mergeAll(dbLayer, makeIdServiceTest(["artifact_multi1"]), FsServiceLive, silentOutput),
      ),
    )

    await Effect.runPromise(
      Effect.provide(
        artifactAddCommand({
          task: taskId,
          run: runId,
          kind: "design-brief",
          title: "Design notes",
          bodyFile: undefined,
        }),
        Layer.mergeAll(dbLayer, makeIdServiceTest(["artifact_multi2"]), FsServiceLive, silentOutput),
      ),
    )

    const db = new Database(dbPath)
    const rows = db
      .prepare("SELECT id, kind FROM artifacts WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as { id: string; kind: string }[]
    db.close()

    expect(rows).toHaveLength(2)
    expect(rows[0]!.id).toBe("artifact_multi1")
    expect(rows[1]!.id).toBe("artifact_multi2")
  })
})

// ---------------------------------------------------------------------------
// 3. parseArgs — artifact:add routing
// ---------------------------------------------------------------------------

describe("parseArgs — artifact add", () => {
  it("parses all required flags", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "artifact",
        "add",
        "--task",
        "task_abc",
        "--run",
        "run_xyz",
        "--kind",
        "worker-completion",
        "--title",
        "Worker report",
      ]),
    )
    expect(result).toMatchObject({
      command: "artifact:add",
      task: "task_abc",
      run: "run_xyz",
      kind: "worker-completion",
      title: "Worker report",
      bodyFile: undefined,
    })
  })

  it("parses --body-file flag", async () => {
    const result = await Effect.runPromise(
      parseArgs([
        "artifact",
        "add",
        "--task",
        "task_abc",
        "--run",
        "run_xyz",
        "--kind",
        "worker-completion",
        "--title",
        "Report",
        "--body-file",
        "/tmp/report.md",
      ]),
    )
    expect(result).toMatchObject({
      command: "artifact:add",
      bodyFile: "/tmp/report.md",
    })
  })

  it("routes 'artifact add --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["artifact", "add", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "artifact:add" })
  })

  it("routes 'artifact --help' to help topic", async () => {
    const result = await Effect.runPromise(parseArgs(["artifact", "--help"]))
    expect(result).toMatchObject({ command: "help", topic: "artifact" })
  })

  it("routes 'artifact' with no subcommand to help", async () => {
    const result = await Effect.runPromise(parseArgs(["artifact"]))
    expect(result).toMatchObject({ command: "help" })
  })

  it("routes unknown artifact subcommand to unknown", async () => {
    const result = await Effect.runPromise(parseArgs(["artifact", "remove"]))
    expect(result).toMatchObject({ command: "unknown" })
  })
})

// ---------------------------------------------------------------------------
// 4. CLI process smoke tests
// ---------------------------------------------------------------------------

describe("pithos artifact add (CLI process)", () => {
  let tempDir: string
  let dbPath: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = join(tempDir, "pithos.sqlite")
    env = { ...process.env, PITHOS_DB: dbPath }
    execFileSync(BIN, ["init"], { env, encoding: "utf-8" })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const cliEnqueue = (): string => {
    const out = execFileSync(
      BIN,
      ["enqueue", "--scope", "global", "--capability", "watch", "--title", "Test task"],
      { env, encoding: "utf-8" },
    )
    return (JSON.parse(out) as { task: { id: string } }).task.id
  }

  const cliRegisterRun = (): string => {
    const out = execFileSync(BIN, ["run", "register", "--agent-kind", "envy"], {
      env,
      encoding: "utf-8",
    })
    return (JSON.parse(out) as { run: { id: string } }).run.id
  }

  it("adds a worker-completion artifact and returns ok:true", () => {
    const taskId = cliEnqueue()
    const runId = cliRegisterRun()

    const stdout = execFileSync(
      BIN,
      [
        "artifact",
        "add",
        "--task",
        taskId,
        "--run",
        runId,
        "--kind",
        "worker-completion",
        "--title",
        "Worker report",
      ],
      { env, encoding: "utf-8" },
    )

    const parsed = JSON.parse(stdout) as {
      ok: boolean
      artifact: { id: string; kind: string; title: string; task_id: string; run_id: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.artifact.kind).toBe("worker-completion")
    expect(parsed.artifact.title).toBe("Worker report")
    expect(parsed.artifact.task_id).toBe(taskId)
    expect(parsed.artifact.run_id).toBe(runId)
    expect(parsed.artifact.id).toMatch(/^artifact_/)
  })

  it("reads body from --body-file", () => {
    const taskId = cliEnqueue()
    const runId = cliRegisterRun()

    const reportPath = join(tempDir, "report.md")
    const reportContent = "## Summary\n\nAll good."
    writeFileSync(reportPath, reportContent)

    const stdout = execFileSync(
      BIN,
      [
        "artifact",
        "add",
        "--task",
        taskId,
        "--run",
        runId,
        "--kind",
        "worker-completion",
        "--title",
        "Report",
        "--body-file",
        reportPath,
      ],
      { env, encoding: "utf-8" },
    )

    const parsed = JSON.parse(stdout) as {
      ok: boolean
      artifact: { id: string; body: string }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.artifact.body).toBe(reportContent)
  })

  it("inspect task shows artifact after add", () => {
    const taskId = cliEnqueue()
    const runId = cliRegisterRun()

    execFileSync(
      BIN,
      [
        "artifact",
        "add",
        "--task",
        taskId,
        "--run",
        runId,
        "--kind",
        "worker-completion",
        "--title",
        "Completion report",
      ],
      { env, encoding: "utf-8" },
    )

    const inspectOut = execFileSync(BIN, ["inspect", "task", taskId], {
      env,
      encoding: "utf-8",
    })
    const inspected = JSON.parse(inspectOut) as {
      ok: boolean
      task: { id: string }
      artifacts: { kind: string; title: string }[]
    }

    expect(inspected.ok).toBe(true)
    expect(inspected.artifacts).toHaveLength(1)
    expect(inspected.artifacts[0]!.kind).toBe("worker-completion")
    expect(inspected.artifacts[0]!.title).toBe("Completion report")
  })

  it("exits 2 when --task is missing", () => {
    const runId = cliRegisterRun()
    const result = spawnSync(
      BIN,
      ["artifact", "add", "--run", runId, "--kind", "worker-completion", "--title", "Report"],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(2)
  })

  it("exits 2 when --run is missing", () => {
    const taskId = cliEnqueue()
    const result = spawnSync(
      BIN,
      ["artifact", "add", "--task", taskId, "--kind", "worker-completion", "--title", "Report"],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(2)
  })

  it("exits 2 when --kind is missing", () => {
    const taskId = cliEnqueue()
    const runId = cliRegisterRun()
    const result = spawnSync(
      BIN,
      ["artifact", "add", "--task", taskId, "--run", runId, "--title", "Report"],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(2)
  })

  it("exits 2 when --title is missing", () => {
    const taskId = cliEnqueue()
    const runId = cliRegisterRun()
    const result = spawnSync(
      BIN,
      ["artifact", "add", "--task", taskId, "--run", runId, "--kind", "worker-completion"],
      { env, encoding: "utf-8" },
    )
    expect(result.status).toBe(2)
  })

  it("exits 1 when --body-file does not exist", () => {
    const taskId = cliEnqueue()
    const runId = cliRegisterRun()
    const result = spawnSync(
      BIN,
      [
        "artifact",
        "add",
        "--task",
        taskId,
        "--run",
        runId,
        "--kind",
        "worker-completion",
        "--title",
        "Report",
        "--body-file",
        "/nonexistent/report.md",
      ],
      { env, encoding: "utf-8" },
    )
    expect(result.status).not.toBe(0)
  })

  it("shows help on --help", () => {
    const stdout = execFileSync(BIN, ["artifact", "add", "--help"], { env, encoding: "utf-8" })
    expect(stdout).toContain("pithos artifact add")
    expect(stdout).toContain("--task")
    expect(stdout).toContain("--run")
    expect(stdout).toContain("--kind")
    expect(stdout).toContain("--title")
    expect(stdout).toContain("--body-file")
  })
})
