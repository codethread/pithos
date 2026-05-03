import { spawn } from "node:child_process"

export interface SpawnDescription {
  readonly env: Record<string, string>
  readonly argv: readonly string[]
  readonly prompt: string
  readonly cwd: string
}

export const buildClaudeArgv = (input: {
  readonly sessionId: string
  readonly model: string
  readonly toolsCsv: string
  readonly prompt: string
}): readonly string[] => [
  "claude",
  "--session-id",
  input.sessionId,
  "--model",
  input.model,
  "--tools",
  input.toolsCsv,
  "--append-system-prompt",
  input.prompt,
]

export const runFake = (description: SpawnDescription): Promise<{ pid: null; output: SpawnDescription; exitCode: 0 }> => Promise.resolve({
  pid: null,
  output: description,
  exitCode: 0,
})

export const runClaude = async (description: SpawnDescription): Promise<{ pid: number | null; output: { exit_code: number | null }; exitCode: number }> =>
  new Promise((resolve, reject) => {
    const child = spawn(description.argv[0] ?? "claude", description.argv.slice(1), {
      cwd: description.cwd,
      env: { ...process.env, ...description.env },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ pid: child.pid ?? null, output: { exit_code: code }, exitCode: code ?? 1 }))
  })
