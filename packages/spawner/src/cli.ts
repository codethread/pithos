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
}

export type ParsedArgs = SpawnOptions | { readonly command: "templates:list" } | { readonly command: "hooks:install" } | { readonly command: "hooks:uninstall" }

const valueAfter = (args: readonly string[], index: number, flag: string): string => {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

export const parseArgs = (args: readonly string[]): ParsedArgs => {
  if (args[0] === "templates" && args[1] === "list") return { command: "templates:list" }
  if (args[0] === "hooks" && args[1] === "install") return { command: "hooks:install" }
  if (args[0] === "hooks" && args[1] === "uninstall") return { command: "hooks:uninstall" }
  if (args.includes("--help") || args.includes("-h")) throw new HelpRequested("Usage: pandora-spawn --agent <name> --scope <scope-id> [--task <id>] [--cwd <path>] [--harness claude|fake]")

  let agent = ""
  let scope = ""
  let task: string | undefined
  let cwd = process.cwd()
  let harness: HarnessName = "claude"
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
    } else if (arg?.startsWith("--")) throw new Error(`Unknown flag: ${arg}`)
  }
  if (!agent) throw new UserInputError("--agent is required")
  if (!scope) throw new UserInputError("--scope is required")
  return task === undefined ? { command: "spawn", agent, scope, cwd, harness } : { command: "spawn", agent, scope, task, cwd, harness }
}
