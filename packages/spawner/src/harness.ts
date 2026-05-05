import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Context, Layer } from "effect"
import { SpawnerError } from "./errors.ts"
import type { HarnessName } from "./harness-name.ts"
import { piExtensionDir } from "./paths.ts"
import type { ClaudeTool, PiTool, SystemPromptMode } from "./template.ts"
import { renderStatus } from "./status.ts"

export interface SpawnDescription {
  readonly env: Record<string, string>
  readonly argv: readonly string[]
  readonly prompt: string
  readonly cwd: string
  readonly session_file?: string
}

export type HarnessBuildInput =
  | {
      readonly kind: "claude"
      readonly sessionId: string
      readonly model: string
      readonly tools: readonly ClaudeTool[]
      readonly systemPromptMode: SystemPromptMode
      readonly prompt: string
      readonly cwd: string
      readonly env: Record<string, string>
      readonly kickoffMessage?: string
    }
  | {
      readonly kind: "pi"
      readonly sessionId: string
      readonly model: string
      readonly tools: readonly PiTool[]
      readonly systemPromptMode: SystemPromptMode
      readonly prompt: string
      readonly cwd: string
      readonly env: Record<string, string>
      readonly kickoffMessage?: string
    }

export interface HarnessRunInput {
  readonly agent: string
  readonly sessionId: string
}

export interface TmuxRunOutput {
  readonly tmux_session: string
  readonly script_path: string
  readonly pane_pid: number | null
}

export type HarnessOutput = SpawnDescription | TmuxRunOutput | (TmuxRunOutput & { readonly session_file: string })

export interface HarnessRunResult {
  readonly pid: number | null
  readonly output: HarnessOutput
  readonly exitCode: number
}

export interface HarnessAdapter {
  readonly name: HarnessName
  readonly describe: (input: HarnessBuildInput) => SpawnDescription
  readonly run: (description: SpawnDescription, input: HarnessRunInput) => HarnessRunResult
}

export interface HarnessServiceShape {
  readonly get: (name: HarnessName) => HarnessAdapter
  readonly renderStatus: (sessionId: string, lines: number) => string
}

export class HarnessService extends Context.Tag("HarnessService")<HarnessService, HarnessServiceShape>() {}

const shquote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export const tmuxSessionName = (agent: string, sessionId: string): string =>
  `pithos-${agent}-${sessionId.slice(0, 8)}`

export const buildClaudeArgv = (input: {
  readonly sessionId: string
  readonly model: string
  readonly tools: readonly ClaudeTool[]
  readonly prompt: string
  readonly kickoffMessage?: string
  readonly systemPromptMode: SystemPromptMode
}): readonly string[] => {
  const base: string[] = [
    "claude",
    "--session-id",
    input.sessionId,
    "--dangerously-skip-permissions",
    "--model",
    input.model,
  ]
  if (input.tools.length > 0) base.push("--tools", input.tools.join(","))
  if (input.systemPromptMode === "append") {
    base.push("--append-system-prompt", input.prompt)
  } else {
    base.push("--system-prompt", input.prompt)
  }
  if (input.kickoffMessage !== undefined) base.push(input.kickoffMessage)
  return base
}

const canonicalCwd = (cwd: string): string => existsSync(cwd) ? realpathSync(cwd) : cwd

const piSessionsRoot = (): string =>
  process.env.PANDORA_SPAWN_PI_SESSIONS_ROOT ?? join(homedir(), ".pi", "agent", "sessions")

const piSessionBucket = (cwd: string): string =>
  `--${canonicalCwd(cwd).replace(/^\/+/, "").replace(/[/:\\]/g, "-")}--`

export const piSessionFile = (cwd: string, sessionId: string): string =>
  join(piSessionsRoot(), piSessionBucket(cwd), `${sessionId}.jsonl`)

const ensurePiSessionFile = (cwd: string, sessionId: string): string => {
  const sessionFile = piSessionFile(cwd, sessionId)
  if (existsSync(sessionFile)) return sessionFile
  mkdirSync(dirname(sessionFile), { recursive: true })
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd,
  }
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" })
  return sessionFile
}

export const buildPiArgv = (input: {
  readonly sessionId: string
  readonly model: string
  readonly tools: readonly PiTool[]
  readonly prompt: string
  readonly cwd: string
  readonly kickoffMessage?: string
  readonly systemPromptMode: SystemPromptMode
}): { readonly argv: readonly string[]; readonly sessionFile: string } => {
  const sessionFile = piSessionFile(input.cwd, input.sessionId)
  const base: string[] = [
    "pi",
    "--session-dir",
    piSessionsRoot(),
    "--session",
    sessionFile,
    "--model",
    input.model,
    "--extension",
    piExtensionDir,
  ]
  if (input.tools.length > 0) base.push("--tools", input.tools.join(","))
  if (input.systemPromptMode === "append") {
    base.push("--append-system-prompt", input.prompt)
  } else {
    base.push("--system-prompt", input.prompt)
  }
  if (input.kickoffMessage !== undefined) base.push(input.kickoffMessage)
  return { argv: base, sessionFile }
}

const runFake = (description: SpawnDescription): HarnessRunResult => ({
  pid: null,
  output: description,
  exitCode: 0,
})

const runInTmux = (description: SpawnDescription, input: HarnessRunInput): HarnessRunResult => {
  const session = tmuxSessionName(input.agent, input.sessionId)
  const dir = mkdtempSync(join(tmpdir(), "pandora-spawn-"))
  const scriptPath = join(dir, "spawn.sh")
  const envExports = Object.entries(description.env)
    .map(([key, value]) => `export ${key}=${shquote(value)}`)
    .join("\n")
  const command = description.argv.map(shquote).join(" ")
  const scriptBody = `#!/usr/bin/env bash\nset -euo pipefail\n${envExports}\nexec ${command}\n`
  writeFileSync(scriptPath, scriptBody)
  chmodSync(scriptPath, 0o755)

  const launch = spawnSync(
    "tmux",
    ["new-session", "-d", "-s", session, "-c", description.cwd, `bash ${shquote(scriptPath)}`],
    { stdio: "inherit" },
  )
  if (launch.status !== 0) {
    throw new Error(`tmux new-session -s ${session} failed (exit ${launch.status ?? "null"})`)
  }

  const panePid = spawnSync("tmux", ["list-panes", "-t", session, "-F", "#{pane_pid}"], {
    encoding: "utf8",
  })
  const pidLine = panePid.stdout.split("\n").find((line) => line.trim().length > 0)
  const pid = pidLine ? Number(pidLine.trim()) : Number.NaN
  const finalPid = Number.isFinite(pid) ? pid : null
  const output: TmuxRunOutput = {
    tmux_session: session,
    script_path: scriptPath,
    pane_pid: finalPid,
  }
  return { pid: finalPid, output, exitCode: 0 }
}

const claudeHarness: HarnessAdapter = {
  name: "claude",
  describe: (input) => {
    if (input.kind !== "claude") {
      throw new SpawnerError({ code: "VALIDATION_ERROR", message: `claude harness received ${input.kind} config` })
    }
    return {
      env: input.env,
      argv: buildClaudeArgv({
        sessionId: input.sessionId,
        model: input.model,
        tools: input.tools,
        prompt: input.prompt,
        systemPromptMode: input.systemPromptMode,
        ...(input.kickoffMessage !== undefined ? { kickoffMessage: input.kickoffMessage } : {}),
      }),
      prompt: input.prompt,
      cwd: input.cwd,
    }
  },
  run: runInTmux,
}

const piHarness: HarnessAdapter = {
  name: "pi",
  describe: (input) => {
    if (input.kind !== "pi") {
      throw new SpawnerError({ code: "VALIDATION_ERROR", message: `pi harness received ${input.kind} config` })
    }
    const { argv, sessionFile } = buildPiArgv({
      sessionId: input.sessionId,
      model: input.model,
      tools: input.tools,
      prompt: input.prompt,
      cwd: input.cwd,
      systemPromptMode: input.systemPromptMode,
      ...(input.kickoffMessage !== undefined ? { kickoffMessage: input.kickoffMessage } : {}),
    })
    return {
      env: input.env,
      argv,
      prompt: input.prompt,
      cwd: input.cwd,
      session_file: sessionFile,
    }
  },
  run: (description, input) => {
    const sessionFile = ensurePiSessionFile(description.cwd, input.sessionId)
    const result = runInTmux(description, input)
    return { ...result, output: { ...result.output, session_file: sessionFile } }
  },
}

const fakeHarness: HarnessAdapter = {
  name: "fake",
  describe: (input) => input.kind === "claude" ? claudeHarness.describe(input) : piHarness.describe(input),
  run: (description) => runFake(description),
}

export const HarnessServiceLive = Layer.succeed(HarnessService, {
  get: (name) => {
    switch (name) {
      case "claude":
        return claudeHarness
      case "pi":
        return piHarness
      case "fake":
        return fakeHarness
    }
  },
  renderStatus,
})
