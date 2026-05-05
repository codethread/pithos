import { readFileSync } from "node:fs"
import { basename, join } from "node:path"

export class TemplateError extends Error { readonly exitCode = 2 }

export interface LauncherManifest {
  readonly kind: string
  readonly harness: string
  readonly commands: {
    readonly spawn: string
    readonly status: string
    readonly nudge: string
    readonly kill: string
    readonly tty_status: string
  }
  readonly meta: Record<string, string>
}

export type AgentType = "afk" | "hitl"

export interface AgentManifest {
  readonly agent: string
  readonly model: string
  readonly tools: readonly string[]
  readonly capability: string
  readonly type: AgentType
  readonly cwd: string | undefined
  readonly includes: readonly string[]
  readonly system_prompt: string
  readonly launcher: string | undefined
  readonly inject_meta: boolean
}

export interface LoadedTemplate {
  readonly manifest: AgentManifest
  readonly launcher: LauncherManifest | undefined
  readonly body: string
  readonly includes: Record<string, string>
}

export type RenderContext = Record<string, string>

const readTemplateFile = (path: string): string => {
  try {
    return readFileSync(path, "utf8")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new TemplateError(`${path}: failed to read template file: ${message}`)
  }
}

const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string")

const readStringField = (path: string, raw: Record<string, unknown>, field: string): string => {
  const value = raw[field]
  if (typeof value !== "string" || value.length === 0) throw new TemplateError(`${path}: ${field} must be a non-empty string`)
  return value
}

const readOptionalStringField = (path: string, raw: Record<string, unknown>, field: string): string | undefined => {
  const value = raw[field]
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0) throw new TemplateError(`${path}: ${field} must be a non-empty string`)
  return value
}

const readTypeField = (path: string, raw: Record<string, unknown>): AgentType => {
  const value = raw.type
  if (typeof value !== "string" || (value !== "afk" && value !== "hitl")) throw new TemplateError(`${path}: type must be "afk" or "hitl"`)
  return value
}

const readBooleanField = (path: string, raw: Record<string, unknown>, field: string): boolean => {
  const value = raw[field]
  if (value === undefined) return false
  if (typeof value !== "boolean") throw new TemplateError(`${path}: ${field} must be a boolean`)
  return value
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string")

const readCommandMap = (path: string, raw: Record<string, unknown>): LauncherManifest["commands"] => {
  const commands = raw.commands
  if (typeof commands !== "object" || commands === null || Array.isArray(commands)) throw new TemplateError(`${path}: commands must be an object`)
  const commandRecord = commands as Record<string, unknown>
  return {
    spawn: readStringField(path, commandRecord, "spawn"),
    status: readStringField(path, commandRecord, "status"),
    nudge: readStringField(path, commandRecord, "nudge"),
    kill: readStringField(path, commandRecord, "kill"),
    tty_status: readStringField(path, commandRecord, "tty_status"),
  }
}

const parseLauncherManifest = (path: string, parsed: unknown): LauncherManifest => {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TemplateError(`${path}: launcher manifest must be a JSON object`)
  const raw = parsed as Record<string, unknown>
  const meta = raw.meta
  if (meta !== undefined && !isStringRecord(meta)) throw new TemplateError(`${path}: meta must be a string object`)
  return {
    kind: readStringField(path, raw, "kind"),
    harness: readStringField(path, raw, "harness"),
    commands: readCommandMap(path, raw),
    meta: meta ?? {},
  }
}

const parseOneManifest = (path: string, parsed: unknown): AgentManifest => {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TemplateError(`${path}: agent manifest must be a JSON object`)
  const raw = parsed as Record<string, unknown>
  const tools = raw.tools
  if (tools !== undefined && !isStringArray(tools)) throw new TemplateError(`${path}: tools must be a string array`)
  const includes = raw.includes
  if (includes !== undefined && !isStringArray(includes)) throw new TemplateError(`${path}: includes must be a string array`)
  return {
    agent: readStringField(path, raw, "agent"),
    model: readStringField(path, raw, "model"),
    tools: isStringArray(tools) && tools.length > 0 ? tools : [],
    capability: readOptionalStringField(path, raw, "capability") ?? "",
    type: readTypeField(path, raw),
    cwd: readOptionalStringField(path, raw, "cwd"),
    includes: includes ?? [],
    system_prompt: readStringField(path, raw, "system_prompt"),
    launcher: readOptionalStringField(path, raw, "launcher"),
    inject_meta: readBooleanField(path, raw, "inject_meta"),
  }
}

interface AgentsFile {
  readonly agents: readonly AgentManifest[]
  readonly launchers: Record<string, LauncherManifest>
}

const loadAgentsFile = (agentsPath: string): AgentsFile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readTemplateFile(agentsPath)) as unknown
  } catch (error: unknown) {
    if (error instanceof TemplateError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new TemplateError(`${agentsPath}: invalid JSON: ${message}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("agents" in parsed)) throw new TemplateError(`${agentsPath}: agents must be a JSON array field`)
  const root = parsed as Record<string, unknown>
  const agents = root.agents
  if (!Array.isArray(agents)) throw new TemplateError(`${agentsPath}: agents must be a JSON array field`)
  const launchersRaw = root.launchers
  if (launchersRaw !== undefined && (typeof launchersRaw !== "object" || launchersRaw === null || Array.isArray(launchersRaw))) throw new TemplateError(`${agentsPath}: launchers must be an object`)
  const launchers = Object.fromEntries(
    Object.entries((launchersRaw ?? {}) as Record<string, unknown>).map(([name, launcher]) => [name, parseLauncherManifest(`${agentsPath}#launchers.${name}`, launcher)]),
  )
  const manifests = agents.map((agent, index) => parseOneManifest(`${agentsPath}#agents[${index}]`, agent))
  const names = new Set<string>()
  for (const manifest of manifests) {
    if (names.has(manifest.agent)) throw new TemplateError(`${agentsPath}: duplicate agent ${manifest.agent}`)
    names.add(manifest.agent)
    if (manifest.launcher !== undefined && !(manifest.launcher in launchers)) throw new TemplateError(`${agentsPath}: unknown launcher for ${manifest.agent}: ${manifest.launcher}`)
  }
  return { agents: manifests, launchers }
}

export const loadAgentManifests = (agentsPath: string): readonly AgentManifest[] => loadAgentsFile(agentsPath).agents

export const loadTemplate = (agentsPath: string, templatesDir: string, agent: string): LoadedTemplate => {
  const agentsFile = loadAgentsFile(agentsPath)
  const manifest = agentsFile.agents.find((item) => item.agent === agent)
  if (!manifest) throw new TemplateError(`${agentsPath}: unknown agent ${agent}`)
  if (basename(manifest.system_prompt) !== manifest.system_prompt) throw new TemplateError(`${agentsPath}: system_prompt must be a template basename`)
  if (manifest.system_prompt !== `${agent}.md.tmpl`) throw new TemplateError(`${agentsPath}: system_prompt must match agent stem: ${agent}.md.tmpl`)
  const includes: Record<string, string> = {}
  for (const include of manifest.includes) {
    if (basename(include) !== include) throw new TemplateError(`${agentsPath}: include must be a template basename: ${include}`)
    includes[include] = readTemplateFile(join(templatesDir, include))
  }
  const launcher = manifest.launcher === undefined ? undefined : agentsFile.launchers[manifest.launcher]
  return { manifest, launcher, body: readTemplateFile(join(templatesDir, manifest.system_prompt)), includes }
}

export const render = (template: string, ctx: RenderContext): string =>
  template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    if (!(key in ctx)) throw new TemplateError(`Unknown template var: ${key}`)
    return ctx[key] ?? ""
  })
