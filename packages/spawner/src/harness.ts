import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface SpawnDescription {
  readonly env: Record<string, string>
  readonly argv: readonly string[]
  readonly prompt: string
  readonly cwd: string
}

export interface ClaudeRunInput {
  readonly agent: string
  readonly sessionId: string
}

export const buildClaudeArgv = (input: {
  readonly sessionId: string
  readonly model: string
  readonly tools: string
  readonly prompt: string
  readonly kickoffMessage?: string
  readonly appendSystemPrompt?: boolean
}): readonly string[] => {
  const base: string[] = [
    "claude",
    "--session-id",
    input.sessionId,
    "--dangerously-skip-permissions",
    "--model",
    input.model,
  ]
  if (input.tools.length > 0) base.push("--tools", input.tools)
  if (input.appendSystemPrompt === true) {
    base.push("--append-system-prompt", input.prompt)
  } else {
    base.push("--system-prompt", input.prompt)
  }
  if (input.kickoffMessage !== undefined) base.push(input.kickoffMessage)
  return base
}

export const tmuxSessionName = (agent: string, sessionId: string): string =>
  `pithos-${agent}-${sessionId.slice(0, 8)}`

const shquote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export interface ClaudeRunOutput {
  readonly tmux_session: string
  readonly script_path: string
  readonly pane_pid: number | null
}

export const runFake = (description: SpawnDescription): { pid: null; output: SpawnDescription; exitCode: 0 } => ({
  pid: null,
  output: description,
  exitCode: 0,
})

export const runClaude = (description: SpawnDescription, input: ClaudeRunInput): { pid: number | null; output: ClaudeRunOutput; exitCode: number } => {
  const session = tmuxSessionName(input.agent, input.sessionId)
  const dir = mkdtempSync(join(tmpdir(), "pandora-spawn-"))
  const scriptPath = join(dir, "spawn.sh")
  const envExports = Object.entries(description.env)
    .map(([key, value]) => `export ${key}=${shquote(value)}`)
    .join("\n")
  const claudeCmd = description.argv.map(shquote).join(" ")
  const scriptBody = `#!/usr/bin/env bash\nset -euo pipefail\n${envExports}\nexec ${claudeCmd}\n`
  writeFileSync(scriptPath, scriptBody)
  chmodSync(scriptPath, 0o755)

  const launch = spawnSync("tmux", ["new-session", "-d", "-s", session, "-c", description.cwd, `bash ${shquote(scriptPath)}`], { stdio: "inherit" })
  if (launch.status !== 0) throw new Error(`tmux new-session -s ${session} failed (exit ${launch.status ?? "null"})`)

  const panePid = spawnSync("tmux", ["list-panes", "-t", session, "-F", "#{pane_pid}"], { encoding: "utf8" })
  const pidLine = panePid.stdout.split("\n").find((line) => line.trim().length > 0)
  const pid = pidLine ? Number(pidLine.trim()) : Number.NaN
  const finalPid = Number.isFinite(pid) ? pid : null
  return { pid: finalPid, output: { tmux_session: session, script_path: scriptPath, pane_pid: finalPid }, exitCode: 0 }
}
