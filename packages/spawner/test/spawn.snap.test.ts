import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const buildSpawner = () => {
  execFileSync("pnpm", ["--filter", "@pithos/pithos", "build"], { stdio: "ignore" })
  execFileSync("pnpm", ["--filter", "@pithos/spawner", "build"], { stdio: "ignore" })
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url))
const spawnerBin = join(packageRoot, "bin", "pandora-spawn")
const pithosBin = join(workspaceRoot, "packages", "pithos", "bin", "pithos-next")
const piExtensionPath = join(packageRoot, "pi-extension")

const previewEnv = () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pandora-spawn-db-")), "pithos.sqlite")
  const env = {
    ...process.env,
    PANDORA_SPAWN_PI_SESSIONS_ROOT: "/tmp/pandora-spawn-pi-sessions",
    PITHOS_BIN: "pithos-next",
    PITHOS_DB: dbPath,
  }
  execFileSync(process.execPath, [pithosBin, "init"], { env, stdio: "ignore" })
  return env
}

const preview = (input: {
  readonly agent: "pandora" | "toil" | "greed" | "war"
  readonly mode: "afk" | "hitl"
  readonly scope: string
  readonly run: string
  readonly sessionId: string
  readonly cwd: string
}) => {
  const out = execFileSync(
    process.execPath,
    [
      spawnerBin,
      "preview",
      "--agent",
      input.agent,
      "--mode",
      input.mode,
      "--scope",
      input.scope,
      "--run",
      input.run,
      "--session-id",
      input.sessionId,
      "--cwd",
      input.cwd,
    ],
    {
      env: previewEnv(),
    },
  ).toString()

  return JSON.parse(out) as {
    readonly agent: string
    readonly mode: string
    readonly runId: string
    readonly sessionId: string
    readonly scopeId: string
    readonly cwd: string
    readonly logicalName: string
    readonly harness: {
      readonly kind: string
      readonly argv: readonly string[]
      readonly env: Record<string, string>
    }
    readonly prompt: string
  }
}

const normalizePreview = (rendered: ReturnType<typeof preview>) => ({
  ...rendered,
  harness: {
    ...rendered.harness,
    argv: rendered.harness.argv.map((value) => {
      if (value === piExtensionPath) {
        return "<pi-extension>"
      }

      return value.endsWith("session_PREVIEW.jsonl") ? "<pi-session-file>" : value
    }),
    env: {
      ...rendered.harness.env,
      ...(rendered.harness.env.PITHOS_DB !== undefined ? { PITHOS_DB: "<pithos-db>" } : {}),
    },
  },
})

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

buildSpawner()

test.each([
  {
    agent: "pandora" as const,
    mode: "hitl" as const,
    scope: "global",
    run: "run_PREVIEW",
    sessionId: "session_PREVIEW",
    cwd: "/tmp/pandora-home",
    harnessKind: "pi",
    claimCapability: "escalate",
  },
  {
    agent: "toil" as const,
    mode: "afk" as const,
    scope: "repo:work/example",
    run: "run_PREVIEW",
    sessionId: "session_PREVIEW",
    cwd: "/tmp/work-example",
    harnessKind: "claude",
    claimCapability: "triage",
  },
  {
    agent: "greed" as const,
    mode: "hitl" as const,
    scope: "global",
    run: "run_PREVIEW",
    sessionId: "session_PREVIEW",
    cwd: "/tmp/pandora-home",
    harnessKind: "pi",
    claimCapability: "design",
  },
  {
    agent: "war" as const,
    mode: "afk" as const,
    scope: "repo:work/example",
    run: "run_PREVIEW",
    sessionId: "session_PREVIEW",
    cwd: "/tmp/work-example",
    harnessKind: "claude",
    claimCapability: "execute",
  },
])("preview renders $agent", (input) => {
  const rendered = preview(input)

  expect(rendered.agent).toBe(input.agent)
  expect(rendered.mode).toBe(input.mode)
  expect(rendered.runId).toBe(input.run)
  expect(rendered.sessionId).toBe(input.sessionId)
  expect(rendered.scopeId).toBe(input.scope)
  expect(rendered.cwd).toBe(input.cwd)
  expect(rendered.logicalName.length).toBeGreaterThan(0)
  expect(rendered.harness.kind).toBe(input.harnessKind)
  expect(rendered.harness.argv.length).toBeGreaterThan(0)
  expect(rendered.harness.env).toEqual(
    expect.objectContaining({
      PITHOS_AGENT: input.agent,
      PITHOS_BIN: "pithos-next",
      PITHOS_OUTPUT: "json",
      PITHOS_RUN_ID: input.run,
      PITHOS_SCOPE_ID: input.scope,
      PITHOS_SESSION_ID: input.sessionId,
    }),
  )
  expect(rendered.harness.env.PITHOS_DB).toBeTypeOf("string")
  expect(rendered.prompt.length).toBeGreaterThan(0)
  expect(rendered.prompt).toContain(
    `${shellQuote("pithos-next")} task claim --run ${shellQuote(input.run)} --scope ${shellQuote(input.scope)} --capability ${shellQuote(input.claimCapability)}`,
  )
  expect(normalizePreview(rendered)).toMatchSnapshot()
}, 20_000)

test("preview rejects mode mismatch loudly", () => {
  const failure = (() => {
    try {
      execFileSync(
        process.execPath,
        [
          spawnerBin,
          "preview",
          "--agent",
          "war",
          "--mode",
          "hitl",
          "--scope",
          "repo:work/example",
          "--run",
          "run_PREVIEW",
          "--session-id",
          "session_PREVIEW",
          "--cwd",
          "/tmp/work-example",
        ],
        {
          env: previewEnv(),
          stdio: "pipe",
        },
      )
      return undefined
    } catch (error: unknown) {
      return error as { readonly status?: number; readonly stderr?: Buffer }
    }
  })()

  if (failure === undefined) {
    throw new Error("expected preview to fail")
  }

  expect(failure.status).toBe(2)
  expect(failure.stderr?.toString()).toContain("Mode mismatch")
}, 20_000)
