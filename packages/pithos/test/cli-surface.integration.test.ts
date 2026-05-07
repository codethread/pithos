import Database from "better-sqlite3"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildCli } from "./_helpers/build.ts"
import { runCli, runCliOk } from "./_helpers/exec.ts"

const PKG_DIR = join(import.meta.dirname, "..")
const BIN = join(PKG_DIR, "bin", "pithos-next")

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-next-cli-"))
}

function makeEnv(tempDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PITHOS_DB: join(tempDir, "pithos-next.sqlite"),
    PITHOS_LOG_LEVEL: "none",
  }
}

async function runJson<T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> {
  const result = await runCli(BIN, args, env)
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout) as T
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

describe("pithos-next CLI surface", () => {
  const tempDirs: string[] = []

  beforeAll(async () => {
    await buildCli(PKG_DIR)
  })

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it("top-level help exposes the nested command surface and flat aliases are absent", async () => {
    const result = await runCli(BIN, ["--help"], {
      ...process.env,
      PITHOS_DB: "/dev/null",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("init")
    expect(result.stdout).toContain("scope")
    expect(result.stdout).toContain("run")
    expect(result.stdout).toContain("task")
    expect(result.stdout).toContain("graph")
    expect(result.stdout).toContain("events")
    expect(result.stdout).toContain("briefing")
    expect(result.stdout).toContain("task enqueue")
    expect(result.stdout).toContain("task claim")
    expect(result.stdout).toContain("task heartbeat")
    expect(result.stdout).not.toMatch(/^\s*- enqueue\b/m)
    expect(result.stdout).not.toMatch(/^\s*- claim\b/m)
    expect(result.stdout).not.toMatch(/^\s*- heartbeat\b/m)
  })

  it("task and run namespace help list their nested subcommands", async () => {
    const taskHelp = await runCli(BIN, ["task", "--help"], {
      ...process.env,
      PITHOS_DB: "/dev/null",
    })
    expect(taskHelp.exitCode).toBe(0)
    for (const name of [
      "enqueue",
      "claim",
      "heartbeat",
      "complete",
      "fail",
      "supersede",
      "cancel",
      "inspect",
      "artifact",
    ]) {
      expect(taskHelp.stdout).toContain(name)
    }

    const runHelp = await runCli(BIN, ["run", "--help"], {
      ...process.env,
      PITHOS_DB: "/dev/null",
    })
    expect(runHelp.exitCode).toBe(0)
    expect(runHelp.stdout).toContain("upsert")
    expect(runHelp.stdout).toContain("inspect")
  })

  it("init --fresh seeds the schema and plain init is idempotent", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)

    const fresh = await runJson<{ ok: boolean; initialized: boolean }>(["init", "--fresh"], env)
    expect(fresh).toEqual({ ok: true, initialized: true })

    const dbPath = env.PITHOS_DB ?? join(tempDir, "pithos-next.sqlite")
    const db = new Database(dbPath)
    const agentKinds = db.prepare("SELECT agent_kind FROM agent_kinds ORDER BY agent_kind ASC").all() as {
      agent_kind: string
    }[]
    const capabilities = db
      .prepare("SELECT capability FROM capabilities ORDER BY capability ASC")
      .all() as { capability: string }[]
    const claimRules = db
      .prepare("SELECT agent_kind, capability FROM agent_claims ORDER BY agent_kind ASC, capability ASC")
      .all() as { agent_kind: string; capability: string }[]
    const enqueueRules = db
      .prepare("SELECT agent_kind, capability FROM agent_enqueues ORDER BY agent_kind ASC, capability ASC")
      .all() as { agent_kind: string; capability: string }[]
    const globalScope = db.prepare("SELECT id, kind FROM scopes WHERE id = 'global'").get() as
      | { id: string; kind: string }
      | undefined
    const partialIndex = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_runs_task_id'")
      .get() as { sql: string } | undefined
    db.close()

    expect(agentKinds.map((row) => row.agent_kind)).toEqual([
      "greed",
      "pandora",
      "pdx",
      "toil",
      "war",
    ])
    expect(capabilities.map((row) => row.capability)).toEqual([
      "design",
      "escalate",
      "execute",
      "triage",
    ])
    expect(claimRules).toEqual([
      { agent_kind: "greed", capability: "design" },
      { agent_kind: "pandora", capability: "escalate" },
      { agent_kind: "toil", capability: "triage" },
      { agent_kind: "war", capability: "execute" },
    ])
    expect(enqueueRules).toEqual([
      { agent_kind: "greed", capability: "design" },
      { agent_kind: "greed", capability: "escalate" },
      { agent_kind: "greed", capability: "triage" },
      { agent_kind: "pandora", capability: "design" },
      { agent_kind: "pandora", capability: "escalate" },
      { agent_kind: "pandora", capability: "triage" },
      { agent_kind: "pdx", capability: "escalate" },
      { agent_kind: "toil", capability: "design" },
      { agent_kind: "toil", capability: "escalate" },
      { agent_kind: "toil", capability: "execute" },
      { agent_kind: "toil", capability: "triage" },
      { agent_kind: "war", capability: "escalate" },
    ])
    expect(globalScope).toEqual({ id: "global", kind: "global" })
    expect(partialIndex?.sql).toContain("WHERE task_id IS NOT NULL")

    const rerun = await runJson<{ ok: boolean; initialized: boolean }>(["init"], env)
    expect(rerun).toEqual({ ok: true, initialized: false })
  })

  it("run upsert is idempotent and rejects identity rewrites for an existing run id", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)

    await runCliOk(BIN, ["init", "--fresh"], env)
    const created = await runJson<RunJson>(
      [
        "run",
        "upsert",
        "--agent",
        "toil",
        "--mode",
        "afk",
        "--scope",
        "global",
        "--cwd",
        tempDir,
        "--session-id",
        "session_original",
        "--run",
        "run_fixed",
      ],
      env,
    )
    expect(created.run).toMatchObject({
      id: "run_fixed",
      agent: "toil",
      mode: "afk",
      scope_id: "global",
      session_id: "session_original",
    })

    const idempotent = await runJson<RunJson>(
      [
        "run",
        "upsert",
        "--agent",
        "toil",
        "--mode",
        "afk",
        "--scope",
        "global",
        "--cwd",
        tempDir,
        "--session-id",
        "session_original",
        "--run",
        "run_fixed",
      ],
      env,
    )
    expect(idempotent.run).toEqual(created.run)

    const rewrite = await runCli(
      BIN,
      [
        "run",
        "upsert",
        "--agent",
        "war",
        "--mode",
        "afk",
        "--scope",
        "global",
        "--cwd",
        tempDir,
        "--session-id",
        "session_rewritten",
        "--run",
        "run_fixed",
      ],
      env,
    )
    expect(rewrite.exitCode).toBe(2)
    const rewriteJson = JSON.parse(rewrite.stderr) as {
      ok: false
      error: { code: string; message: string }
    }
    expect(rewriteJson).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    })
    expect(rewriteJson.error.message).toContain("immutable fields")
  })

  it("fails loudly when --run conflicts with PITHOS_RUN_ID", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)

    await runCliOk(BIN, ["init", "--fresh"], env)
    await runCliOk(
      BIN,
      [
        "run",
        "upsert",
        "--agent",
        "toil",
        "--mode",
        "afk",
        "--scope",
        "global",
        "--cwd",
        tempDir,
        "--session-id",
        "session_a",
        "--run",
        "run_a",
      ],
      env,
    )
    await runCliOk(
      BIN,
      [
        "run",
        "upsert",
        "--agent",
        "toil",
        "--mode",
        "afk",
        "--scope",
        "global",
        "--cwd",
        tempDir,
        "--session-id",
        "session_b",
        "--run",
        "run_b",
      ],
      env,
    )

    const result = await runCli(
      BIN,
      [
        "task",
        "enqueue",
        "--scope",
        "global",
        "--capability",
        "triage",
        "--title",
        "Conflict task",
        "--body",
        "conflict body",
        "--run",
        "run_b",
      ],
      {
        ...env,
        PITHOS_RUN_ID: "run_a",
      },
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("Conflicting run identity")
  })

  it("parser validation failures emit structured JSON instead of raw help text", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)

    const invalidAgent = await runCli(
      BIN,
      [
        "run",
        "upsert",
        "--agent",
        "unknown-agent",
        "--mode",
        "afk",
        "--scope",
        "global",
        "--cwd",
        tempDir,
        "--session-id",
        "session_bad",
      ],
      env,
    )
    expect(invalidAgent.exitCode).toBe(2)
    const invalidAgentJson = JSON.parse(invalidAgent.stderr) as {
      ok: false
      error: { code: string; message: string }
    }
    expect(invalidAgentJson).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    })
    expect(invalidAgentJson.error.message).toContain("Expected one of the following cases")
    expect(invalidAgent.stderr).not.toContain("USAGE")

    const missingMode = await runCli(
      BIN,
      [
        "run",
        "upsert",
        "--agent",
        "toil",
        "--scope",
        "global",
        "--cwd",
        tempDir,
        "--session-id",
        "session_missing_mode",
      ],
      env,
    )
    expect(missingMode.exitCode).toBe(2)
    const missingModeJson = JSON.parse(missingMode.stderr) as {
      ok: false
      error: { code: string; message: string }
    }
    expect(missingModeJson).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    })
    expect(missingModeJson.error.message).toContain("mode")
    expect(missingMode.stderr).not.toContain("USAGE")
  })

  it("plain init rejects an incompatible old-schema database", async () => {
    const tempDir = makeTempDir()
    tempDirs.push(tempDir)
    const env = makeEnv(tempDir)
    const dbPath = env.PITHOS_DB ?? join(tempDir, "pithos-next.sqlite")

    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE scopes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        canonical_path TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        agent_kind TEXT NOT NULL,
        scope_id TEXT,
        task_id TEXT,
        parent_run_id TEXT,
        harness TEXT NOT NULL DEFAULT 'claude-code',
        session_id TEXT,
        tmux_target TEXT,
        cwd TEXT,
        status TEXT NOT NULL,
        last_heartbeat_at TEXT,
        last_hook TEXT,
        last_summary TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        lease_owner_run_id TEXT,
        lease_until TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        result_json TEXT NOT NULL DEFAULT '{}',
        created_by_run_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      );
    `)
    db.close()

    const result = await runCli(BIN, ["init"], env)
    expect(result.exitCode).toBe(2)
    const parsed = JSON.parse(result.stderr) as {
      ok: false
      error: { code: string; message: string }
    }
    expect(parsed).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    })
    expect(parsed.error.message).toContain("incompatible")
    expect(parsed.error.message).toMatch(/runs|tasks/)
  })
})
