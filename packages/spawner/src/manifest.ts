import { homedir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SPAWNABLE_AGENT_KINDS, type SpawnableAgentKind } from "@pdx/pithos/builtins";
import { Either, ParseResult, Schema } from "effect";
import * as Toml from "@iarna/toml";
import { SpawnerError } from "./errors.js";
import {
	bundledDataDirResourcesDir,
	resolveAgentsPath,
	resolveTemplatesDir,
	resolveUserDataDir,
	type ScopeKind,
} from "./paths.js";
import type { RenderAgentInput } from "./spawner.js";
import type { RenderServices } from "./services.js";

const HarnessKindSchema = Schema.Literal("claude", "pi");
const SystemPromptModeSchema = Schema.Literal("replace", "append");
const NonEmptyStringArray = Schema.Array(Schema.NonEmptyString);

const ScalarDefaultSchema = Schema.Struct({ default: Schema.Literal(true) });
const ListOpsSchema = Schema.Struct({
	replace: Schema.optional(NonEmptyStringArray),
	remove: Schema.optional(NonEmptyStringArray),
	add: Schema.optional(NonEmptyStringArray),
});
const ArgvListOpsSchema = Schema.Struct({
	replace: Schema.optional(NonEmptyStringArray),
	add: Schema.optional(NonEmptyStringArray),
});
const ScalarStringOrDefaultSchema = Schema.Union(Schema.NonEmptyString, ScalarDefaultSchema);
const ScalarBooleanSchema = Schema.Boolean;
const HookCommandSchema = Schema.Array(Schema.NonEmptyString).pipe(Schema.minItems(1));

const PartialHarnessSchema = Schema.Struct({
	kind: Schema.optional(HarnessKindSchema),
	model: Schema.optional(ScalarStringOrDefaultSchema),
	system_prompt_mode: Schema.optional(SystemPromptModeSchema),
	tools: Schema.optional(ListOpsSchema),
	argv: Schema.optional(ArgvListOpsSchema),
});

const PartialAgentSchema = Schema.Struct({
	template: Schema.optional(ScalarStringOrDefaultSchema),
	includes: Schema.optional(ListOpsSchema),
	appends: Schema.optional(ListOpsSchema),
	harness: Schema.optional(PartialHarnessSchema),
});

const PartialHooksSchema = Schema.Struct({
	input: Schema.optional(
		Schema.Struct({
			enabled: Schema.optional(ScalarBooleanSchema),
			command: Schema.optional(HookCommandSchema),
		}),
	),
});

const PartialAgentsTableSchema = Schema.Struct({
	pandora: Schema.optional(PartialAgentSchema),
	toil: Schema.optional(PartialAgentSchema),
	greed: Schema.optional(PartialAgentSchema),
	war: Schema.optional(PartialAgentSchema),
	envy: Schema.optional(PartialAgentSchema),
});

const PartialAgentsFileSchema = Schema.Struct({
	agents: Schema.optional(PartialAgentsTableSchema),
	hooks: Schema.optional(PartialHooksSchema),
});

const ResolvedHarnessSchema = Schema.Struct({
	kind: HarnessKindSchema,
	model: Schema.NonEmptyString,
	system_prompt_mode: SystemPromptModeSchema,
	tools: Schema.optional(NonEmptyStringArray),
	argv: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), { default: () => [] }),
});

const ResolvedAgentSchema = Schema.Struct({
	template: Schema.NonEmptyString,
	includes: Schema.optionalWith(NonEmptyStringArray, { default: () => [] }),
	appends: Schema.optionalWith(NonEmptyStringArray, { default: () => [] }),
	harness: ResolvedHarnessSchema,
});

const ResolvedHooksSchema = Schema.Struct({
	input: Schema.optional(
		Schema.Struct({
			enabled: Schema.optional(Schema.Boolean),
			command: Schema.optional(HookCommandSchema),
		}),
	),
});

export type HooksConfig = Schema.Schema.Type<typeof ResolvedHooksSchema>;
export type ResolvedAgentManifest = Schema.Schema.Type<typeof ResolvedAgentSchema> & {
	readonly templatePinnedToBundled: boolean;
};

interface ConfigLayer {
	readonly rootDir: string;
	readonly templatesDir: string;
	readonly agentsPath: string;
	readonly scopeKind: ScopeKind;
	readonly kind: "bundled" | "user" | "user-scope" | "project" | "project-scope";
	readonly required: boolean;
}

export interface ResolvedTemplateAsset {
	readonly reference: string;
	readonly path: string;
	readonly content: string;
	readonly layer:
		| { readonly type: "absolute" | "home" }
		| {
				readonly type: "layer";
				readonly kind: ConfigLayer["kind"];
				readonly scopeKind: ScopeKind;
				readonly rootDir: string;
		  };
}

type PartialAgentsFile = Schema.Schema.Type<typeof PartialAgentsFileSchema>;

interface ResolvedConfig {
	readonly layers: readonly ConfigLayer[];
	readonly bundledLayer: ConfigLayer;
	readonly hooks: HooksConfig;
	readonly agents: Readonly<Record<SpawnableAgentKind, ResolvedAgentManifest>>;
}

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown, path: string): A => {
	const decoded = Schema.decodeUnknownEither(schema)(value);
	if (Either.isLeft(decoded)) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${path}: invalid manifest\n${ParseResult.TreeFormatter.formatErrorSync(decoded.left)}`,
		});
	}
	return decoded.right;
};

const parseTomlFile = (path: string, services: RenderServices): PartialAgentsFile => {
	let raw: string;
	try {
		raw = services.readText(path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new SpawnerError({ code: "TEMPLATE_ERROR", message: `${path}: ${message}` });
	}
	let parsed: unknown;
	try {
		parsed = Toml.parse(raw);
	} catch (error) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${path}: invalid TOML\n${error instanceof Error ? error.message : String(error)}`,
		});
	}
	return decode(PartialAgentsFileSchema, parsed, path);
};

const isEnoent = (error: unknown): boolean =>
	error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

const maybeParseTomlFile = (
	path: string,
	services: RenderServices,
): PartialAgentsFile | undefined => {
	try {
		return parseTomlFile(path, services);
	} catch (error) {
		if (
			error instanceof SpawnerError &&
			error.code === "TEMPLATE_ERROR" &&
			error.message.includes("ENOENT")
		) {
			return undefined;
		}
		if (isEnoent(error)) return undefined;
		throw error;
	}
};

const uniqueValues = (values: readonly string[], field: string, path: string): void => {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			throw new SpawnerError({
				code: "VALIDATION_ERROR",
				message: `${path}: ${field} contains duplicate value '${value}'`,
			});
		}
		seen.add(value);
	}
};

const validateListOps = (
	ops: Schema.Schema.Type<typeof ListOpsSchema> | Schema.Schema.Type<typeof ArgvListOpsSchema>,
	field: string,
	path: string,
	allowRemove: boolean,
	allowDuplicates: boolean,
): void => {
	const replace = "replace" in ops ? ops.replace : undefined;
	const remove = "remove" in ops ? ops.remove : undefined;
	const add = "add" in ops ? ops.add : undefined;
	if (replace !== undefined && (remove !== undefined || add !== undefined)) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${path}: ${field} replace may not be combined with add/remove`,
		});
	}
	if (!allowRemove && remove !== undefined) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${path}: ${field} does not support remove`,
		});
	}
	if (!allowDuplicates) {
		if (replace !== undefined) uniqueValues(replace, `${field}.replace`, path);
		if (remove !== undefined) uniqueValues(remove, `${field}.remove`, path);
		if (add !== undefined) uniqueValues(add, `${field}.add`, path);
	}
};

const validatePartialFile = (file: PartialAgentsFile, layer: ConfigLayer): void => {
	for (const [agent, partial] of Object.entries(file.agents ?? {})) {
		if (partial === undefined) continue;
		if (partial.includes !== undefined) {
			validateListOps(partial.includes, `agents.${agent}.includes`, layer.agentsPath, true, false);
		}
		if (partial.appends !== undefined) {
			validateListOps(partial.appends, `agents.${agent}.appends`, layer.agentsPath, true, false);
		}
		if (partial.harness?.tools !== undefined) {
			validateListOps(
				partial.harness.tools,
				`agents.${agent}.harness.tools`,
				layer.agentsPath,
				true,
				false,
			);
		}
		if (partial.harness?.argv !== undefined) {
			validateListOps(
				partial.harness.argv,
				`agents.${agent}.harness.argv`,
				layer.agentsPath,
				false,
				true,
			);
		}
	}
	const input = file.hooks?.input;
	if (input?.enabled === false && input.command !== undefined) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${layer.agentsPath}: hooks.input may not set enabled=false together with command`,
		});
	}
	if (
		input !== undefined &&
		(layer.scopeKind === "repo" || layer.scopeKind === "worktree") &&
		(layer.kind === "user-scope" || layer.kind === "project" || layer.kind === "project-scope")
	) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${layer.agentsPath}: hooks.input is only valid in bundled, user, or scopes/global manifests`,
		});
	}
};

const agentModeFor = (agent: SpawnableAgentKind): "afk" | "hitl" =>
	agent === "pandora" || agent === "greed" ? "hitl" : "afk";

const scalarValue = (value: string | { readonly default: true } | undefined): string | undefined =>
	typeof value === "string" ? value : undefined;
const scalarIsDefault = (
	value: string | { readonly default: true } | undefined,
): value is { readonly default: true } =>
	typeof value === "object" && value !== null && value.default === true;

const mergeUniqueList = (
	current: readonly string[],
	ops: Schema.Schema.Type<typeof ListOpsSchema> | undefined,
	field: string,
	path: string,
): readonly string[] => {
	if (ops === undefined) return current;
	if (ops.replace !== undefined) return ops.replace;
	const next = [...current];
	for (const value of ops.remove ?? []) {
		const index = next.indexOf(value);
		if (index === -1) {
			throw new SpawnerError({
				code: "VALIDATION_ERROR",
				message: `${path}: ${field} cannot remove absent value '${value}'`,
			});
		}
		next.splice(index, 1);
	}
	for (const value of ops.add ?? []) {
		if (next.includes(value)) {
			throw new SpawnerError({
				code: "VALIDATION_ERROR",
				message: `${path}: ${field} cannot add duplicate value '${value}'`,
			});
		}
		next.push(value);
	}
	return next;
};

const mergeArgvList = (
	current: readonly string[],
	ops: Schema.Schema.Type<typeof ArgvListOpsSchema> | undefined,
): readonly string[] => {
	if (ops === undefined) return current;
	if (ops.replace !== undefined) return ops.replace;
	return [...current, ...(ops.add ?? [])];
};

const normalizeScopeKind = (input: Pick<RenderAgentInput, "scopeId">): ScopeKind => {
	if (input.scopeId === "global") return "global";
	if (input.scopeId.startsWith("repo:")) return "repo";
	if (input.scopeId.startsWith("worktree:")) return "worktree";
	return "repo";
};

const scopePathFromId = (input: Pick<RenderAgentInput, "scopeId" | "cwd">): string | undefined => {
	for (const prefix of ["repo:", "worktree:"] as const) {
		if (input.scopeId.startsWith(prefix)) {
			return input.scopeId.slice(prefix.length) || input.cwd;
		}
	}
	return undefined;
};

const resolveLayer = (
	rootDir: string,
	scopeKind: ScopeKind,
	kind: ConfigLayer["kind"],
	required: boolean,
): ConfigLayer => ({
	rootDir,
	templatesDir: join(rootDir, "templates"),
	agentsPath: kind === "bundled" ? resolveAgentsPath(rootDir) : join(rootDir, "agents.toml"),
	scopeKind,
	kind,
	required,
});

const bundledLayerFor = (services: RenderServices): ConfigLayer => {
	const dataDir = services.env("PDX_DATA_DIR");
	return {
		rootDir: dataDir ?? bundledDataDirResourcesDir,
		templatesDir: resolveTemplatesDir(dataDir),
		agentsPath: resolveAgentsPath(dataDir),
		scopeKind: "global",
		kind: "bundled",
		required: true,
	};
};

const layerOrderForRender = (
	input: RenderAgentInput,
	services: RenderServices,
): readonly ConfigLayer[] => {
	const scopeKind = normalizeScopeKind(input);
	if (scopeKind === "worktree" && input.parentRepoPath === undefined) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `worktree scope ${input.scopeId} requires parentRepoPath for layered config resolution`,
		});
	}
	const bundledLayer = bundledLayerFor(services);
	const dataDir = services.env("PDX_DATA_DIR");
	const userDataDir = resolveUserDataDir(dataDir, services.env("PDX_USER_DATA_DIR"));
	const layers: ConfigLayer[] = [bundledLayer];
	if (userDataDir !== undefined) {
		layers.push(resolveLayer(userDataDir, "global", "user", false));
		layers.push(
			resolveLayer(join(userDataDir, "scopes", scopeKind), scopeKind, "user-scope", false),
		);
	}
	if (scopeKind === "repo") {
		const scopePath = scopePathFromId(input);
		if (scopePath !== undefined) {
			layers.push(resolveLayer(join(scopePath, ".pdx"), "repo", "project", false));
			layers.push(
				resolveLayer(join(scopePath, ".pdx", "scopes", "repo"), "repo", "project-scope", false),
			);
		}
	}
	if (scopeKind === "worktree" && input.parentRepoPath !== undefined) {
		layers.push(resolveLayer(join(input.parentRepoPath, ".pdx"), "worktree", "project", false));
		layers.push(
			resolveLayer(
				join(input.parentRepoPath, ".pdx", "scopes", "worktree"),
				"worktree",
				"project-scope",
				false,
			),
		);
	}
	return layers;
};

const hookLayers = (services: RenderServices): readonly ConfigLayer[] => {
	const bundledLayer = bundledLayerFor(services);
	const dataDir = services.env("PDX_DATA_DIR");
	const userDataDir = resolveUserDataDir(dataDir, services.env("PDX_USER_DATA_DIR"));
	const layers: ConfigLayer[] = [bundledLayer];
	if (userDataDir !== undefined) {
		layers.push(resolveLayer(userDataDir, "global", "user", false));
		layers.push(resolveLayer(join(userDataDir, "scopes", "global"), "global", "user-scope", false));
	}
	return layers;
};

const validateProjectConfigRoots = (
	layers: readonly ConfigLayer[],
	services: RenderServices,
): void => {
	for (const layer of layers) {
		if (layer.kind !== "project" && layer.kind !== "project-scope") continue;
		const projectConfigRoot =
			layer.kind === "project" ? layer.rootDir : join(layer.rootDir, "..", "..");
		const invalidGlobalAgentsPath = join(projectConfigRoot, "scopes", "global", "agents.toml");
		const invalidGlobalManifest = maybeParseTomlFile(invalidGlobalAgentsPath, services);
		if (invalidGlobalManifest !== undefined) {
			throw new SpawnerError({
				code: "VALIDATION_ERROR",
				message: `${invalidGlobalAgentsPath}: project-local .pdx may not define scopes/global`,
			});
		}
	}
};

const readLayerFiles = (
	layers: readonly ConfigLayer[],
	services: RenderServices,
): readonly [ConfigLayer, PartialAgentsFile][] => {
	const files: [ConfigLayer, PartialAgentsFile][] = [];
	for (const layer of layers) {
		const parsed = layer.required
			? parseTomlFile(layer.agentsPath, services)
			: maybeParseTomlFile(layer.agentsPath, services);
		if (parsed !== undefined) {
			validatePartialFile(parsed, layer);
			files.push([layer, parsed]);
		}
	}
	return files;
};

const buildResolvedConfig = (
	layers: readonly ConfigLayer[],
	services: RenderServices,
): ResolvedConfig => {
	validateProjectConfigRoots(layers, services);
	const layerFiles = readLayerFiles(layers, services);
	const bundledLayerEntry = layerFiles[0];
	if (bundledLayerEntry === undefined) {
		throw new SpawnerError({ code: "VALIDATION_ERROR", message: "missing bundled agents.toml" });
	}
	const [bundledLayer, bundledFile] = bundledLayerEntry;
	const agents = Object.fromEntries(
		BUILTIN_SPAWNABLE_AGENT_KINDS.map((agent) => {
			const bundledAgent = bundledFile.agents?.[agent];
			if (bundledAgent === undefined) {
				throw new SpawnerError({
					code: "VALIDATION_ERROR",
					message: `${bundledLayer.agentsPath}: missing canonical agents.${agent}`,
				});
			}
			const resolved = {
				template: scalarValue(bundledAgent.template),
				templatePinnedToBundled: false,
				includes: bundledAgent.includes?.replace ?? [],
				appends: bundledAgent.appends?.replace ?? [],
				harness: {
					kind: bundledAgent.harness?.kind,
					model: scalarValue(bundledAgent.harness?.model),
					system_prompt_mode: bundledAgent.harness?.system_prompt_mode,
					tools: bundledAgent.harness?.tools?.replace,
					argv: bundledAgent.harness?.argv?.replace ?? [],
				},
			};
			return [agent, resolved];
		}),
	) as Record<
		SpawnableAgentKind,
		{
			template: string | undefined;
			templatePinnedToBundled: boolean;
			includes: readonly string[];
			appends: readonly string[];
			harness: {
				kind: "claude" | "pi" | undefined;
				model: string | undefined;
				system_prompt_mode: "replace" | "append" | undefined;
				tools: readonly string[] | undefined;
				argv: readonly string[];
			};
		}
	>;
	let hooks: HooksConfig = decode(
		ResolvedHooksSchema,
		bundledFile.hooks ?? {},
		bundledLayer.agentsPath,
	);

	for (const [layer, file] of layerFiles.slice(1)) {
		for (const agent of BUILTIN_SPAWNABLE_AGENT_KINDS) {
			const partial = file.agents?.[agent];
			if (partial === undefined) continue;
			const current = agents[agent];
			if (scalarIsDefault(partial.template)) {
				current.template = scalarValue(bundledFile.agents?.[agent]?.template);
				current.templatePinnedToBundled = true;
			} else if (typeof partial.template === "string") {
				current.template = partial.template;
				current.templatePinnedToBundled = false;
			}
			current.includes = mergeUniqueList(
				current.includes,
				partial.includes,
				`agents.${agent}.includes`,
				layer.agentsPath,
			);
			current.appends = mergeUniqueList(
				current.appends,
				partial.appends,
				`agents.${agent}.appends`,
				layer.agentsPath,
			);
			if (partial.harness?.kind !== undefined) current.harness.kind = partial.harness.kind;
			if (scalarIsDefault(partial.harness?.model)) {
				current.harness.model = scalarValue(bundledFile.agents?.[agent]?.harness?.model);
			} else if (typeof partial.harness?.model === "string") {
				current.harness.model = partial.harness.model;
			}
			if (partial.harness?.system_prompt_mode !== undefined) {
				current.harness.system_prompt_mode = partial.harness.system_prompt_mode;
			}
			if (partial.harness?.tools !== undefined) {
				current.harness.tools = mergeUniqueList(
					current.harness.tools ?? [],
					partial.harness.tools,
					`agents.${agent}.harness.tools`,
					layer.agentsPath,
				);
			}
			current.harness.argv = mergeArgvList(current.harness.argv, partial.harness?.argv);
		}
		const hookInput = file.hooks?.input;
		if (hookInput !== undefined) {
			const nextInput = {
				enabled: hookInput.enabled ?? hooks.input?.enabled,
				command: hookInput.command ?? hooks.input?.command,
			};
			hooks = decode(ResolvedHooksSchema, { input: nextInput }, layer.agentsPath);
		}
	}

	const resolvedAgents = Object.fromEntries(
		BUILTIN_SPAWNABLE_AGENT_KINDS.map((agent) => {
			const current = agents[agent];
			const resolved = decode(
				ResolvedAgentSchema,
				{
					template: current.template,
					includes: current.includes,
					appends: current.appends,
					harness: {
						kind: current.harness.kind,
						model: current.harness.model,
						system_prompt_mode: current.harness.system_prompt_mode,
						tools: current.harness.tools,
						argv: current.harness.argv,
					},
				},
				`${bundledLayer.agentsPath}: resolved agents.${agent}`,
			);
			uniqueValues(resolved.includes, `agents.${agent}.includes`, bundledLayer.agentsPath);
			uniqueValues(resolved.appends, `agents.${agent}.appends`, bundledLayer.agentsPath);
			if (resolved.harness.tools !== undefined) {
				uniqueValues(
					resolved.harness.tools,
					`agents.${agent}.harness.tools`,
					bundledLayer.agentsPath,
				);
			}
			return [agent, { ...resolved, templatePinnedToBundled: current.templatePinnedToBundled }];
		}),
	) as Readonly<Record<SpawnableAgentKind, ResolvedAgentManifest>>;
	return { layers, bundledLayer, hooks, agents: resolvedAgents };
};

const resolveAbsoluteOrHomePath = (reference: string): string => {
	if (reference === "~") return homedir();
	if (reference.startsWith("~/")) return join(homedir(), reference.slice(2));
	return reference;
};

const readText = (path: string, services: RenderServices): string => {
	try {
		return services.readText(path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new SpawnerError({ code: "TEMPLATE_ERROR", message: `${path}: ${message}` });
	}
};

export const loadResolvedAgentConfig = (
	input: RenderAgentInput,
	services: RenderServices,
): ResolvedConfig => buildResolvedConfig(layerOrderForRender(input, services), services);

export const loadResolvedHooks = (services: RenderServices): HooksConfig =>
	buildResolvedConfig(hookLayers(services), services).hooks;

export const resolveTemplateAsset = (
	reference: string,
	config: Pick<ResolvedConfig, "layers" | "bundledLayer">,
	services: RenderServices,
	options: { readonly pinToBundled?: boolean } = {},
): ResolvedTemplateAsset => {
	if (reference === "~" || reference.startsWith("~/") || reference.startsWith("/")) {
		const path = resolveAbsoluteOrHomePath(reference);
		return {
			reference,
			path,
			content: readText(path, services),
			layer: { type: reference.startsWith("/") ? "absolute" : "home" },
		};
	}
	if (options.pinToBundled === true) {
		const path = join(config.bundledLayer.templatesDir, reference);
		return {
			reference,
			path,
			content: readText(path, services),
			layer: {
				type: "layer",
				kind: config.bundledLayer.kind,
				scopeKind: config.bundledLayer.scopeKind,
				rootDir: config.bundledLayer.rootDir,
			},
		};
	}
	for (const layer of [...config.layers].reverse()) {
		const path = join(layer.templatesDir, reference);
		try {
			return {
				reference,
				path,
				content: services.readText(path),
				layer: {
					type: "layer",
					kind: layer.kind,
					scopeKind: layer.scopeKind,
					rootDir: layer.rootDir,
				},
			};
		} catch (error) {
			if (!isEnoent(error)) {
				throw new SpawnerError({
					code: "TEMPLATE_ERROR",
					message: `${path}: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	}
	throw new SpawnerError({
		code: "TEMPLATE_ERROR",
		message: `template asset not found in any config layer: ${reference}`,
	});
};

export { agentModeFor, type ConfigLayer, type ResolvedConfig, type ScopeKind };
