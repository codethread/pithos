import { readFileSync } from "node:fs"
import { basename, join } from "node:path"

export class TemplateError extends Error { readonly exitCode = 2 }

export interface AgentManifest {
  readonly agent: string
  readonly model: string
  readonly tools: readonly string[]
  readonly capability: string
  readonly includes: readonly string[]
  readonly system_prompt: string
}

export interface LoadedTemplate {
  readonly manifest: AgentManifest
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

const parseOneManifest = (path: string, parsed: unknown): AgentManifest => {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TemplateError(`${path}: agent manifest must be a JSON object`)
  const raw = parsed as Record<string, unknown>
  const tools = raw.tools
  if (!isStringArray(tools) || tools.length === 0) throw new TemplateError(`${path}: tools must be a non-empty string array`)
  const includes = raw.includes
  if (includes !== undefined && !isStringArray(includes)) throw new TemplateError(`${path}: includes must be a string array`)
  return {
    agent: readStringField(path, raw, "agent"),
    model: readStringField(path, raw, "model"),
    tools,
    capability: readStringField(path, raw, "capability"),
    includes: includes ?? [],
    system_prompt: readStringField(path, raw, "system_prompt"),
  }
}

export const loadAgentManifests = (agentsPath: string): readonly AgentManifest[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readTemplateFile(agentsPath)) as unknown
  } catch (error: unknown) {
    if (error instanceof TemplateError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new TemplateError(`${agentsPath}: invalid JSON: ${message}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("agents" in parsed)) throw new TemplateError(`${agentsPath}: agents must be a JSON array field`)
  const agents = (parsed as { readonly agents: unknown }).agents
  if (!Array.isArray(agents)) throw new TemplateError(`${agentsPath}: agents must be a JSON array field`)
  const manifests = agents.map((agent, index) => parseOneManifest(`${agentsPath}#agents[${index}]`, agent))
  const names = new Set<string>()
  for (const manifest of manifests) {
    if (names.has(manifest.agent)) throw new TemplateError(`${agentsPath}: duplicate agent ${manifest.agent}`)
    names.add(manifest.agent)
  }
  return manifests
}

export const loadTemplate = (agentsPath: string, templatesDir: string, agent: string): LoadedTemplate => {
  const manifest = loadAgentManifests(agentsPath).find((item) => item.agent === agent)
  if (!manifest) throw new TemplateError(`${agentsPath}: unknown agent ${agent}`)
  if (basename(manifest.system_prompt) !== manifest.system_prompt) throw new TemplateError(`${agentsPath}: system_prompt must be a template basename`)
  if (manifest.system_prompt !== `${agent}.md.tmpl`) throw new TemplateError(`${agentsPath}: system_prompt must match agent stem: ${agent}.md.tmpl`)
  const includes: Record<string, string> = {}
  for (const include of manifest.includes) {
    if (basename(include) !== include) throw new TemplateError(`${agentsPath}: include must be a template basename: ${include}`)
    includes[include] = readTemplateFile(join(templatesDir, include))
  }
  return { manifest, body: readTemplateFile(join(templatesDir, manifest.system_prompt)), includes }
}

export const render = (template: string, ctx: RenderContext): string =>
  template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    if (!(key in ctx)) throw new TemplateError(`Unknown template var: ${key}`)
    return ctx[key] ?? ""
  })
