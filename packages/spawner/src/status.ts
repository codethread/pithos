import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type JsonRecord = Readonly<Record<string, unknown>>
interface StatusMessage { readonly ts: string; readonly role: string; readonly text: string }

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value)

const findFiles = (root: string, predicate: (name: string) => boolean): readonly string[] => {
  if (!existsSync(root)) return []
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) throw new Error("directory stack underflow")
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && predicate(entry.name)) out.push(path)
    }
  }
  return out
}

const findClaudeSession = (sessionId: string): string | undefined => findFiles(join(homedir(), ".claude", "projects"), (name) => name === `${sessionId}.jsonl`)[0]

const readJsonl = (path: string): readonly JsonRecord[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown
        return isRecord(parsed) ? [parsed] : []
      } catch {
        return []
      }
    })

const fmtTs = (value: unknown): string => (typeof value === "string" ? value.slice(0, 19).replace("T", " ") : "")

const textFromContent = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const text = content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
  if (text.length > 0) return text
  const tools = content
    .filter(isRecord)
    .filter((item) => item.type === "tool_use" && typeof item.name === "string")
    .map((item) => item.name as string)
  return tools.length > 0 ? `[tools: ${tools.join(", ")}]` : ""
}

const parseClaude = (path: string): readonly StatusMessage[] =>
  readJsonl(path).flatMap((entry) => {
    if (entry.type !== "user" && entry.type !== "assistant") return []
    const message = entry.message
    if (!isRecord(message)) return []
    const text = textFromContent(message.content)
    if (text.length === 0) return []
    return [{ ts: fmtTs(entry.timestamp), role: String(entry.type).toUpperCase(), text }]
  })

export const renderStatus = (sessionId: string, lines: number): string => {
  const claudeFile = findClaudeSession(sessionId)
  if (claudeFile === undefined) throw new Error(`session not found: ${sessionId}`)
  return parseClaude(claudeFile)
    .slice(-lines)
    .map((message) => {
      const oneLine = message.text.replace(/\s+/g, " ").trim()
      const snippet = oneLine.length > 400 ? oneLine.slice(0, 400) : oneLine
      return `[${message.ts}] ${message.role}: ${snippet}`
    })
    .join("\n")
}
