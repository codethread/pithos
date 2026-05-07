import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { Either, ParseResult, Schema } from "effect"
import { SpawnerError } from "./errors.ts"

const SystemPromptModeSchema = Schema.Literal("replace", "append")
const ClaudeToolSchema = Schema.Literal("Bash", "Read", "Edit", "Write", "Grep", "Glob", "LS")
const PiToolSchema = Schema.Literal("bash", "read", "edit", "write", "grep", "find", "ls")

const ClaudeHarnessConfigSchema = Schema.Struct({
  kind: Schema.Literal("claude"),
  model: Schema.NonEmptyString,
  tools: Schema.Array(ClaudeToolSchema).pipe(Schema.minItems(1)),
  system_prompt_mode: SystemPromptModeSchema,
})

const PiHarnessConfigSchema = Schema.Struct({
  kind: Schema.Literal("pi"),
  model: Schema.NonEmptyString,
  tools: Schema.Array(PiToolSchema).pipe(Schema.minItems(1)),
  system_prompt_mode: SystemPromptModeSchema,
})

const HarnessConfigSchema = Schema.Union(ClaudeHarnessConfigSchema, PiHarnessConfigSchema)

const LauncherCommandsSchema = Schema.Struct({
  spawn: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  nudge: Schema.NonEmptyString,
  kill: Schema.NonEmptyString,
  tty_status: Schema.NonEmptyString,
})

const LauncherManifestSchema = Schema.Struct({
  kind: Schema.NonEmptyString,
  harness: Schema.NonEmptyString,
  commands: LauncherCommandsSchema,
  meta: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.String }), {
    default: () => ({}),
  }),
})

const AgentManifestSchema = Schema.Struct({
  agent: Schema.NonEmptyString,
  harness: HarnessConfigSchema,
  capability: Schema.optionalWith(Schema.String, { default: () => "" }),
  cwd: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
  includes: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), { default: () => [] }),
  system_prompt: Schema.NonEmptyString,
  launcher: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
  inject_meta: Schema.optionalWith(Schema.Boolean, { default: () => false }),
})

const AgentsFileSchema = Schema.Struct({
  agents: Schema.Array(AgentManifestSchema),
  launchers: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: LauncherManifestSchema }),
    { default: () => ({}) },
  ),
})

export type LauncherManifest = Schema.Schema.Type<typeof LauncherManifestSchema>
export type AgentManifest = Schema.Schema.Type<typeof AgentManifestSchema>
export type HarnessConfig = Schema.Schema.Type<typeof HarnessConfigSchema>
export type SystemPromptMode = Schema.Schema.Type<typeof SystemPromptModeSchema>
export type ClaudeTool = Schema.Schema.Type<typeof ClaudeToolSchema>
export type PiTool = Schema.Schema.Type<typeof PiToolSchema>

export interface LoadedTemplate {
  readonly manifest: AgentManifest
  readonly launcher: LauncherManifest | undefined
  readonly body: string
  readonly includes: Record<string, string>
}

export type RenderContext = Record<string, string>

type AgentsFile = Schema.Schema.Type<typeof AgentsFileSchema>

const schemaError = (path: string, error: ParseResult.ParseError): SpawnerError =>
  new SpawnerError({
    code: "VALIDATION_ERROR",
    message: `${path}: invalid template config\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
  })

const decodeOrThrow = <A, I>(schema: Schema.Schema<A, I>, value: unknown, path: string): A => {
  const decoded = Schema.decodeUnknownEither(schema)(value)
  if (Either.isLeft(decoded)) throw schemaError(path, decoded.left)
  return decoded.right
}

const readTemplateFile = (path: string): string => {
  try {
    return readFileSync(path, "utf8")
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SpawnerError({
      code: "VALIDATION_ERROR",
      message: `${path}: failed to read template file: ${message}`,
    })
  }
}

const loadAgentsFile = (agentsPath: string): AgentsFile => {
  const raw = readTemplateFile(agentsPath)
  const parsed = decodeOrThrow(Schema.parseJson(AgentsFileSchema), raw, agentsPath)
  const names = new Set<string>()
  for (const manifest of parsed.agents) {
    if (names.has(manifest.agent)) {
      throw new SpawnerError({
        code: "VALIDATION_ERROR",
        message: `${agentsPath}: duplicate agent ${manifest.agent}`,
      })
    }
    names.add(manifest.agent)
    if (manifest.launcher !== undefined && !(manifest.launcher in parsed.launchers)) {
      throw new SpawnerError({
        code: "VALIDATION_ERROR",
        message: `${agentsPath}: unknown launcher for ${manifest.agent}: ${manifest.launcher}`,
      })
    }
  }
  return parsed
}

export const loadAgentManifests = (agentsPath: string): readonly AgentManifest[] => loadAgentsFile(agentsPath).agents

export const loadTemplate = (agentsPath: string, templatesDir: string, agent: string): LoadedTemplate => {
  const agentsFile = loadAgentsFile(agentsPath)
  const manifest = agentsFile.agents.find((item) => item.agent === agent)
  if (!manifest) {
    throw new SpawnerError({
      code: "VALIDATION_ERROR",
      message: `${agentsPath}: unknown agent ${agent}`,
    })
  }
  if (basename(manifest.system_prompt) !== manifest.system_prompt) {
    throw new SpawnerError({
      code: "VALIDATION_ERROR",
      message: `${agentsPath}: system_prompt must be a template basename`,
    })
  }
  if (manifest.system_prompt !== `${agent}.md.tmpl`) {
    throw new SpawnerError({
      code: "VALIDATION_ERROR",
      message: `${agentsPath}: system_prompt must match agent stem: ${agent}.md.tmpl`,
    })
  }
  const includes: Record<string, string> = {}
  for (const include of manifest.includes) {
    if (basename(include) !== include) {
      throw new SpawnerError({
        code: "VALIDATION_ERROR",
        message: `${agentsPath}: include must be a template basename: ${include}`,
      })
    }
    includes[include] = readTemplateFile(join(templatesDir, include))
  }
  const launcher = manifest.launcher === undefined ? undefined : agentsFile.launchers[manifest.launcher]
  return { manifest, launcher, body: readTemplateFile(join(templatesDir, manifest.system_prompt)), includes }
}

export const render = (template: string, ctx: RenderContext): string =>
  template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    if (!(key in ctx)) {
      throw new SpawnerError({
        code: "VALIDATION_ERROR",
        message: `Unknown template var: ${key}`,
      })
    }
    return ctx[key] ?? ""
  })
