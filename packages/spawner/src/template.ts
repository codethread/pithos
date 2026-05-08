import * as FileSystem from "@effect/platform/FileSystem"
import { Context, Effect, Layer, ParseResult, Schema } from "effect"
import {
  CapabilitySchema,
  RunModeSchema,
  SpawnableAgentKindSchema,
  type SpawnableAgentKind,
} from "@pithos/pithos/src/domain/control-plane.ts"
import { basename, join } from "node:path"
import { SpawnerError } from "./errors.ts"
import type { HarnessName } from "./harness-name.ts"
import { agentsPath, templatesDir } from "./paths.ts"

const AgentHarnessSchema = Schema.Struct({
  kind: Schema.Literal("claude", "pi"),
})

export const AgentManifestSchema = Schema.Struct({
  agent: SpawnableAgentKindSchema,
  mode: RunModeSchema,
  claims: Schema.Array(CapabilitySchema).pipe(Schema.minItems(1)),
  enqueues: Schema.Array(CapabilitySchema),
  harness: AgentHarnessSchema,
  template: Schema.NonEmptyString,
})

const AgentsFileSchema = Schema.Struct({
  agents: Schema.Array(AgentManifestSchema).pipe(Schema.minItems(1)),
})

export type AgentManifest = Schema.Schema.Type<typeof AgentManifestSchema>
export type TemplateContext = Readonly<Record<string, string>>

export interface LoadedTemplate {
  readonly manifest: AgentManifest
  readonly body: string
}

export interface TemplatePathsShape {
  readonly agentsPath: string
  readonly templatesDir: string
}

export class TemplatePaths extends Context.Tag("@pithos/spawner/TemplatePaths")<
  TemplatePaths,
  TemplatePathsShape
>() {}

export const TemplatePathsLive = Layer.succeed(TemplatePaths, {
  agentsPath,
  templatesDir,
})

export const makeTemplatePaths = (paths: TemplatePathsShape): Layer.Layer<TemplatePaths> =>
  Layer.succeed(TemplatePaths, paths)

type AgentsFile = Schema.Schema.Type<typeof AgentsFileSchema>

const renderParseError = (error: ParseResult.ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(error)

const validationError = (message: string): SpawnerError =>
  new SpawnerError({ code: "VALIDATION_ERROR", message })

const templateError = (message: string): SpawnerError =>
  new SpawnerError({ code: "TEMPLATE_ERROR", message })

const decodeUnknown = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  message: string,
): Effect.Effect<A, SpawnerError> =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError((error) => validationError(`${message}\n${renderParseError(error)}`)),
  )

const readFileUtf8 = (
  path: string,
  code: "VALIDATION_ERROR" | "TEMPLATE_ERROR",
  message: string,
): Effect.Effect<string, SpawnerError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(path, "utf-8").pipe(
      Effect.mapError(
        (error) =>
          new SpawnerError({
            code,
            message: `${message}: ${error.message}`,
          }),
      ),
    )
  })

const validateManifest = (manifest: AgentManifest, sourcePath: string): Effect.Effect<void, SpawnerError> =>
  Effect.gen(function* () {
    if (manifest.claims.length !== 1) {
      yield* Effect.fail(
        validationError(
          `${sourcePath}: ${manifest.agent} must declare exactly one claim; got ${manifest.claims.length}`,
        ),
      )
    }

    if (basename(manifest.template) !== manifest.template) {
      yield* Effect.fail(
        validationError(`${sourcePath}: template must be a basename for ${manifest.agent}`),
      )
    }

    const expectedTemplate = `${manifest.agent}.md.tmpl`
    if (manifest.template !== expectedTemplate) {
      yield* Effect.fail(
        validationError(
          `${sourcePath}: template for ${manifest.agent} must be ${expectedTemplate}; got ${manifest.template}`,
        ),
      )
    }

  })

const loadAgentsFile = (): Effect.Effect<AgentsFile, SpawnerError, FileSystem.FileSystem | TemplatePaths> =>
  Effect.gen(function* () {
    const paths = yield* TemplatePaths
    const raw = yield* readFileUtf8(paths.agentsPath, "VALIDATION_ERROR", `${paths.agentsPath}: failed to read manifest file`)
    const parsedJson = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (error) =>
        validationError(
          `${paths.agentsPath}: invalid manifest file: ${error instanceof Error ? error.message : String(error)}`,
        ),
    })
    const parsed = yield* decodeUnknown(AgentsFileSchema, parsedJson, `${paths.agentsPath}: invalid manifest file`)

    const names = new Set<string>()
    for (const manifest of parsed.agents) {
      if (names.has(manifest.agent)) {
        yield* Effect.fail(
          validationError(`${paths.agentsPath}: duplicate agent manifest for ${manifest.agent}`),
        )
      }
      names.add(manifest.agent)
      yield* validateManifest(manifest, paths.agentsPath)
    }

    return parsed
  })

export const loadTemplate = (
  agent: SpawnableAgentKind,
): Effect.Effect<LoadedTemplate, SpawnerError, FileSystem.FileSystem | TemplatePaths> =>
  Effect.gen(function* () {
    const paths = yield* TemplatePaths
    const agentsFile = yield* loadAgentsFile()
    const manifest = agentsFile.agents.find((candidate) => candidate.agent === agent)

    if (manifest === undefined) {
      return yield* Effect.fail(validationError(`${paths.agentsPath}: unknown agent ${agent}`))
    }

    const templatePath = join(paths.templatesDir, manifest.template)
    const body = yield* readFileUtf8(
      templatePath,
      "TEMPLATE_ERROR",
      `${templatePath}: failed to read template file`,
    )

    return { manifest, body }
  })

export const render = (template: string, context: TemplateContext): Effect.Effect<string, SpawnerError> =>
  Effect.try({
    try: () =>
      template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
        if (!(key in context)) {
          throw templateError(`Unknown template variable: ${key}`)
        }

        return context[key] ?? ""
      }),
    catch: (error) =>
      error instanceof SpawnerError
        ? error
        : templateError(error instanceof Error ? error.message : String(error)),
  })

export const decodeHarnessKind = (raw: unknown): Effect.Effect<HarnessName, SpawnerError> =>
  Schema.decodeUnknown(Schema.Literal("claude", "pi"))(raw).pipe(
    Effect.mapError((error) => validationError(`Invalid harness kind\n${renderParseError(error)}`)),
  )
