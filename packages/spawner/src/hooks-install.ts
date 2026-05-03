import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { hooksDir } from "./paths.ts"

interface HookCommand { readonly type: "command"; readonly command: string }
interface HookEntry { readonly matcher?: string; readonly hooks: readonly HookCommand[] }
interface Settings { hooks?: Record<string, HookEntry[]> }

const settingsPath = () => join(homedir(), ".claude", "settings.json")
const dispatchPath = () => join(hooksDir, "dispatch.sh")

const readSettings = (): Settings => {
  const path = settingsPath()
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, "utf8")) as Settings
}

const writeSettings = (settings: Settings): void => {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
}

export const installHooks = (): void => {
  const settings = readSettings()
  const hooks = settings.hooks ?? {}
  const dispatch = dispatchPath()
  const entries: Record<string, HookEntry> = {
    PreToolUse: { hooks: [{ type: "command", command: `${dispatch} PreToolUse` }] },
    SessionEnd: { matcher: "prompt_input_exit", hooks: [{ type: "command", command: `${dispatch} SessionEnd` }] },
  }
  for (const [name, entry] of Object.entries(entries)) {
    const list = hooks[name] ?? []
    const command = entry.hooks[0]?.command
    hooks[name] = list.some((existing) => existing.matcher === entry.matcher && existing.hooks.some((hook) => hook.command === command)) ? list : [...list, entry]
  }
  writeSettings({ ...settings, hooks })
}

export const uninstallHooks = (): void => {
  const settings = readSettings()
  const dispatch = dispatchPath()
  const hooks: Record<string, HookEntry[]> = {}
  for (const [name, list] of Object.entries(settings.hooks ?? {})) {
    const kept = list.filter((entry) => !entry.hooks.some((hook) => hook.command.startsWith(dispatch)))
    if (kept.length > 0) hooks[name] = kept
  }
  writeSettings({ ...settings, hooks })
}
