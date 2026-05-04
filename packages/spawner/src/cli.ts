export type HarnessName = "claude" | "fake"

export class UserInputError extends Error { readonly exitCode = 1 }
export class HelpRequested extends Error { readonly exitCode = 0 }

export interface SpawnOptions {
  readonly command: "spawn"
  readonly agent: string
  readonly scope: string
  readonly task?: string
  readonly cwd: string
  readonly harness: HarnessName
  readonly preview: boolean
}

export type ParsedArgs =
  | SpawnOptions
  | { readonly command: "templates:list" }
  | { readonly command: "status"; readonly sessionId: string; readonly lines: number }
  | { readonly command: "nudge"; readonly target: string; readonly message: string }
  | { readonly command: "kill"; readonly target: string }
  | { readonly command: "tty-status"; readonly target: string }

const valueAfter = (args: readonly string[], index: number, flag: string): string => {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

export const parseArgs = (args: readonly string[]): ParsedArgs => {
  if (args[0] === "templates" && args[1] === "list") return { command: "templates:list" }
  if (args[0] === "status") {
    let sessionId = ""
    let lines = 10
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === "--session-id") sessionId = valueAfter(args, index, arg)
      else if (arg === "--lines") {
        const raw = valueAfter(args, index, arg)
        lines = Number(raw)
        if (!Number.isInteger(lines) || lines <= 0) throw new UserInputError(`invalid --lines: ${raw}`)
      } else if (arg?.startsWith("--")) throw new UserInputError(`Unknown flag: ${arg}`)
    }
    if (!sessionId) throw new UserInputError("--session-id is required")
    return { command: "status", sessionId, lines }
  }
  if (args[0] === "nudge") {
    let target = ""
    let message = ""
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === "--target") target = valueAfter(args, index, arg)
      else if (arg === "--message") message = valueAfter(args, index, arg)
      else if (arg?.startsWith("--")) throw new UserInputError(`Unknown flag: ${arg}`)
    }
    if (!target) throw new UserInputError("--target is required")
    if (!message) throw new UserInputError("--message is required")
    return { command: "nudge", target, message }
  }
  if (args[0] === "kill" || args[0] === "tty-status") {
    let target = ""
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === "--target") target = valueAfter(args, index, arg)
      else if (arg?.startsWith("--")) throw new UserInputError(`Unknown flag: ${arg}`)
    }
    if (!target) throw new UserInputError("--target is required")
    return { command: args[0], target }
  }
  if (args.includes("--help") || args.includes("-h")) throw new HelpRequested("Usage: pandora-spawn --agent <name> --scope <scope-id> [--task <id>] [--cwd <path>] [--harness claude|fake] [--preview]")

  let agent = ""
  let scope = ""
  let task: string | undefined
  let cwd = process.cwd()
  let harness: HarnessName = "claude"
  let preview = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--agent") agent = valueAfter(args, index, arg)
    else if (arg === "--scope") scope = valueAfter(args, index, arg)
    else if (arg === "--task") task = valueAfter(args, index, arg)
    else if (arg === "--cwd") cwd = valueAfter(args, index, arg)
    else if (arg === "--harness") {
      const raw = valueAfter(args, index, arg)
      if (raw !== "claude" && raw !== "fake") throw new Error("--harness must be claude or fake")
      harness = raw
    } else if (arg === "--preview") preview = true
    else if (arg?.startsWith("--")) throw new Error(`Unknown flag: ${arg}`)
  }
  if (!agent) throw new UserInputError("--agent is required")
  if (!scope) throw new UserInputError("--scope is required")
  return task === undefined ? { command: "spawn", agent, scope, cwd, harness, preview } : { command: "spawn", agent, scope, task, cwd, harness, preview }
}
