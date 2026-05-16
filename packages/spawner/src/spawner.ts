import { homedir } from "node:os";
import { join } from "node:path";
import {
	BUILTIN_AGENT_CLAIMS,
	BUILTIN_AGENT_ENQUEUES,
	BUILTIN_SPAWNABLE_AGENT_KINDS,
	type SpawnableAgentKind,
} from "@pdx/pithos/builtins";
import { Either, ParseResult, Schema } from "effect";
import { SpawnerError } from "./errors.js";
import { resolveAgentsPath, resolveExtensionsTemplatesDir, resolveTemplatesDir } from "./paths.js";
import {
	LiveSpawnerServices,
	type LaunchServices,
	type RenderServices,
	type SpawnedProcess,
} from "./services.js";

export const AgentKindSchema = Schema.Literal(...BUILTIN_SPAWNABLE_AGENT_KINDS);
export const ModeSchema = Schema.Literal("afk", "hitl");

export interface RenderAgentInput {
	readonly agent: SpawnableAgentKind;
	readonly mode: "afk" | "hitl";
	readonly runId: string;
	readonly sessionId: string;
	readonly scopeId: string;
	readonly cwd: string;
}

const HarnessKindSchema = Schema.Literal("claude", "pi");
export type HarnessKind = Schema.Schema.Type<typeof HarnessKindSchema>;

export interface RenderedAgent extends RenderAgentInput {
	readonly logicalName: string;
	readonly harness: {
		readonly kind: HarnessKind;
		readonly argv: readonly string[];
		readonly env: Record<string, string>;
	};
	readonly sessionLogPath: string;
	readonly prompt: string;
}

export interface LaunchResult {
	readonly agent: SpawnableAgentKind;
	readonly mode: "afk" | "hitl";
	readonly runId: string;
	readonly sessionId: string;
	readonly scopeId: string;
	readonly logicalName: string;
	readonly harnessKind: HarnessKind;
	readonly sessionLogPath: string;
	readonly afk?: { readonly pid: number; readonly processStartTime: string };
	readonly hitl?: { readonly tmuxTarget: string; readonly panePid: number | null };
}

export interface RenderSessionTranscriptInput {
	readonly harnessKind: HarnessKind;
	readonly sessionLogPath: string;
	readonly limit?: number;
}

const NonEmptyStringArray = Schema.Array(Schema.NonEmptyString).pipe(Schema.minItems(1));

const HarnessSchema = Schema.Struct({
	kind: HarnessKindSchema,
	model: Schema.NonEmptyString,
	system_prompt_mode: Schema.Literal("replace", "append"),
	tools: Schema.optional(NonEmptyStringArray),
	argv: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), { default: () => [] }),
});

const ManifestSchema = Schema.Struct({
	agent: AgentKindSchema,
	mode: ModeSchema,
	harness: HarnessSchema,
	includes: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), { default: () => [] }),
	appends: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), { default: () => [] }),
	template: Schema.NonEmptyString,
});

const HookCommandSchema = Schema.Array(Schema.NonEmptyString).pipe(Schema.minItems(1));
const InputHookSchema = Schema.Struct({ command: HookCommandSchema });
const HooksSchema = Schema.Struct({ input: Schema.optional(InputHookSchema) });
const AgentsFileSchema = Schema.Struct({
	agents: Schema.Array(ManifestSchema),
	hooks: Schema.optionalWith(HooksSchema, { default: () => ({}) }),
});

export type HooksConfig = Schema.Schema.Type<typeof HooksSchema>;
type AgentsFile = Schema.Schema.Type<typeof AgentsFileSchema>;
type Manifest = Schema.Schema.Type<typeof ManifestSchema>;

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

const PanePidSchema = Schema.NumberFromString.pipe(Schema.int(), Schema.positive());
const UuidSchema = Schema.UUID;

const decodePanePid = (value: string, target: string): number => {
	const decoded = Schema.decodeUnknownEither(PanePidSchema)(value.trim());
	if (Either.isLeft(decoded)) {
		throw new SpawnerError({
			code: "LAUNCH_ERROR",
			message: `tmux list-panes returned invalid pane pid for ${target}: ${JSON.stringify(value)}`,
		});
	}
	return decoded.right;
};

const validateSessionId = (sessionId: string): void => {
	const decoded = Schema.decodeUnknownEither(UuidSchema)(sessionId);
	if (Either.isLeft(decoded)) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `sessionId must be a UUID: ${sessionId}`,
		});
	}
};

const readText = (path: string, services: RenderServices): string => {
	try {
		return services.readText(path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new SpawnerError({ code: "TEMPLATE_ERROR", message: `${path}: ${message}` });
	}
};

const templateAssetPaths = (services: RenderServices) => {
	const pdxDataDir = services.env("PDX_DATA_DIR");
	return {
		agentsPath: resolveAgentsPath(pdxDataDir),
		templatesDir: resolveTemplatesDir(pdxDataDir),
		extensionsTemplatesDir: resolveExtensionsTemplatesDir(pdxDataDir),
	};
};

const loadAgentsFile = (services: RenderServices = LiveSpawnerServices): AgentsFile => {
	const paths = templateAssetPaths(services);
	const agentsFile = resolveWithOverlayFile(
		paths.extensionsTemplatesDir,
		paths.templatesDir,
		"agents.json",
		services,
	);
	const parsed = decode(Schema.parseJson(AgentsFileSchema), agentsFile.content, agentsFile.path);
	for (const manifest of parsed.agents) validateManifestContract(manifest);
	return parsed;
};

const loadManifests = (services: RenderServices = LiveSpawnerServices): readonly Manifest[] =>
	loadAgentsFile(services).agents;

export const loadHooks = (services: RenderServices = LiveSpawnerServices): HooksConfig =>
	loadAgentsFile(services).hooks;

const validateManifestContract = (manifest: Manifest): void => {
	const includeSet = new Set(manifest.includes);
	if (includeSet.size !== manifest.includes.length) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${manifest.agent}: includes must be unique template paths`,
		});
	}
	const appendSet = new Set(manifest.appends);
	if (appendSet.size !== manifest.appends.length) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${manifest.agent}: appends must be unique template paths`,
		});
	}
};

const claimForAgent = (agent: SpawnableAgentKind): string => {
	const claims = BUILTIN_AGENT_CLAIMS[agent];
	if (claims.length !== 1) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${agent}: MVP requires exactly one claim capability`,
		});
	}
	const claim = claims[0];
	if (claim === undefined) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${agent}: missing claim capability`,
		});
	}
	return claim;
};

const renderTemplate = (template: string, ctx: Record<string, string>): string =>
	template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_match, key: string) => {
		if (!(key in ctx))
			throw new SpawnerError({ code: "TEMPLATE_ERROR", message: `Unknown template var: ${key}` });
		return ctx[key] ?? "";
	});

const resolveTemplateReference = (templatesDir: string, path: string): string => {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	if (path.startsWith("/")) return path;
	return join(templatesDir, path);
};

const isEnoent = (error: unknown): boolean =>
	error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

// For templates-relative paths (not absolute or home-relative), prefer
// extensions/templates/<rel> over templates/<rel> so users can override
// individual files without modifying the bundle. Only absent files (ENOENT)
// trigger fallback; permission denied or other IO errors fail loudly.
const resolveWithOverlayFile = (
	extensionsTemplatesDir: string | undefined,
	templatesDir: string,
	path: string,
	services: RenderServices,
): { readonly path: string; readonly content: string } => {
	if (path === "~" || path.startsWith("~/") || path.startsWith("/")) {
		const resolvedPath = resolveTemplateReference(templatesDir, path);
		return { path: resolvedPath, content: readText(resolvedPath, services) };
	}
	if (extensionsTemplatesDir !== undefined) {
		const extensionsPath = join(extensionsTemplatesDir, path);
		try {
			return { path: extensionsPath, content: services.readText(extensionsPath) };
		} catch (error) {
			if (!isEnoent(error)) {
				throw new SpawnerError({
					code: "TEMPLATE_ERROR",
					message: `${extensionsPath}: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
			// file absent in extensions layer; fall through to bundle
		}
	}
	const bundledPath = join(templatesDir, path);
	return { path: bundledPath, content: readText(bundledPath, services) };
};

const resolveWithOverlay = (
	extensionsTemplatesDir: string | undefined,
	templatesDir: string,
	path: string,
	services: RenderServices,
): string => resolveWithOverlayFile(extensionsTemplatesDir, templatesDir, path, services).content;

const SpawnerConfigSchema = Schema.Struct({
	pithosDb: Schema.NonEmptyString,
	pdxDataDir: Schema.optional(Schema.NonEmptyString),
});

const INITIAL_TASK_MESSAGE = "Claim and process one task, then exit.";
const HITL_STARTUP_MESSAGE = "begin";

type SpawnerConfig = Schema.Schema.Type<typeof SpawnerConfigSchema>;

const loadConfig = (services: RenderServices): SpawnerConfig => {
	const dataDir = services.env("PDX_DATA_DIR");
	const pithosDb =
		services.env("PITHOS_DB") ?? (dataDir === undefined ? undefined : `${dataDir}/pithos.sqlite`);
	if (pithosDb === undefined) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: "PITHOS_DB or PDX_DATA_DIR is required for spawner render/preview",
		});
	}
	return decode(
		SpawnerConfigSchema,
		{
			pithosDb,
			pdxDataDir: services.env("PDX_DATA_DIR"),
		},
		"SpawnerConfig",
	);
};

interface CommandHelpCard {
	readonly tool: string;
	readonly name: string;
	readonly path: string;
	readonly usage: string;
	readonly description: string;
	readonly subcommands: readonly CommandHelpCard[];
}

const PITHOS_TOP_LEVEL_PATHS: Record<SpawnableAgentKind, readonly string[]> = {
	war: ["pithos task"],
	toil: ["pithos scope", "pithos task"],
	greed: ["pithos scope", "pithos task"],
	pandora: ["pithos scope", "pithos task", "pithos graph", "pithos events", "pithos briefing"],
	envy: ["pithos scope", "pithos task"],
};

const PANDORA_PDX_COMMAND_PATHS = ["pdx run transcript", "pdx run show", "pdx task show"] as const;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const requiredStringField = (
	record: Readonly<Record<string, unknown>>,
	field: string,
	path: string,
): string => {
	const value = record[field];
	if (typeof value === "string" && value.length > 0) return value;
	throw new SpawnerError({
		code: "TEMPLATE_ERROR",
		message: `${path}: required ${field} must be a non-empty string`,
	});
};

const parseCommandHelpCard = (value: unknown, path: string): CommandHelpCard => {
	if (!isRecord(value)) {
		throw new SpawnerError({
			code: "TEMPLATE_ERROR",
			message: `${path}: command help entry must be an object`,
		});
	}
	const subcommands = value.subcommands;
	if (!Array.isArray(subcommands)) {
		throw new SpawnerError({
			code: "TEMPLATE_ERROR",
			message: `${path}: required subcommands must be an array`,
		});
	}
	return {
		tool: requiredStringField(value, "tool", path),
		name: requiredStringField(value, "name", path),
		path: requiredStringField(value, "path", path),
		usage: requiredStringField(value, "usage", path),
		description: requiredStringField(value, "description", path),
		subcommands: subcommands.map((child, index) =>
			parseCommandHelpCard(child, `${path}.subcommands[${index.toString()}]`),
		),
	};
};

const parseCommandHelpTree = (raw: string, source: string): CommandHelpCard => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		throw new SpawnerError({
			code: "TEMPLATE_ERROR",
			message: `${source}: command help JSON is malformed: ${String(error)}`,
		});
	}
	return parseCommandHelpCard(parsed, source);
};

const pithosHelpTree = (services: RenderServices): CommandHelpCard => {
	const result = services.execFile("pithos", ["--help-json"]);
	if (result.status !== 0) {
		throw new SpawnerError({
			code: "TEMPLATE_ERROR",
			message: `pithos --help-json failed: ${result.stderr}`,
		});
	}
	return parseCommandHelpTree(result.stdout, "pithos help");
};

const pdxHelpTree = (services: RenderServices): CommandHelpCard => {
	const result = services.execFile("pdx", ["--help-json"]);
	if (result.status !== 0) {
		throw new SpawnerError({
			code: "TEMPLATE_ERROR",
			message: `pdx --help-json failed: ${result.stderr}`,
		});
	}
	return parseCommandHelpTree(result.stdout, "pdx help");
};

const flattenHelpTree = (tree: CommandHelpCard): ReadonlyMap<string, CommandHelpCard> => {
	const entries: [string, CommandHelpCard][] = [];
	const visit = (card: CommandHelpCard): void => {
		entries.push([card.path, card]);
		for (const child of card.subcommands) visit(child);
	};
	visit(tree);
	return new Map(entries);
};

const filteredHelpTree = (
	tree: CommandHelpCard,
	paths: readonly string[],
	source: string,
): CommandHelpCard => {
	const selected = new Set(paths);
	const byPath = flattenHelpTree(tree);
	for (const path of selected) {
		if (!byPath.has(path)) {
			throw new SpawnerError({
				code: "TEMPLATE_ERROR",
				message: `${source}: configured command path missing from generated help tree: ${path}`,
			});
		}
	}
	const prune = (card: CommandHelpCard): CommandHelpCard | undefined => {
		if (selected.has(card.path)) return card;
		const subcommands = card.subcommands.flatMap((child) => {
			const pruned = prune(child);
			return pruned === undefined ? [] : [pruned];
		});
		if (subcommands.length > 0) return { ...card, subcommands };
		return undefined;
	};
	return {
		...tree,
		subcommands: tree.subcommands.flatMap((child) => {
			const pruned = prune(child);
			return pruned === undefined ? [] : [pruned];
		}),
	};
};

const renderCommandHelpJson = (value: unknown): string => JSON.stringify(value, null, 2);

const renderCommandCards = (agent: SpawnableAgentKind, services: RenderServices): string => {
	const pithosHelp = filteredHelpTree(
		pithosHelpTree(services),
		PITHOS_TOP_LEVEL_PATHS[agent],
		"pithos help",
	);
	const sections = [
		[
			"## Generated command help JSON",
			"This JSON is generated from CLI help; use the rendered claim command above for the exact claim invocation for this run.",
			"",
			"### Pithos help JSON",
			"```json",
			renderCommandHelpJson(pithosHelp),
			"```",
		].join("\n"),
	];
	if (agent === "pandora") {
		const pdxHelp = filteredHelpTree(pdxHelpTree(services), PANDORA_PDX_COMMAND_PATHS, "pdx help");
		sections.push(
			["### pdx inspection help JSON", "```json", renderCommandHelpJson(pdxHelp), "```"].join("\n"),
		);
	}
	return `${sections.join("\n\n")}\n`;
};

const stripHomePrefix = (path: string): string => {
	const currentHome = homedir().replace(/\/+$/, "");
	if (path === currentHome) return "";
	if (path.startsWith(`${currentHome}/`)) return path.slice(currentHome.length + 1);
	return path
		.replace(/^\/Users\/[^/]+(?=\/|$)/, "")
		.replace(/^\/home\/[^/]+(?=\/|$)/, "")
		.replace(/^\/+/, "");
};

const slugify = (value: string): string =>
	value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const scopeSlug = (input: RenderAgentInput): string => {
	if (input.scopeId === "global") return "global";
	const pathScope = /^(repo|worktree):(.*)$/.exec(input.scopeId);
	if (pathScope !== null) {
		const kind = pathScope[1];
		const rawPath = pathScope[2] ?? "";
		const path = rawPath === "" ? input.cwd : rawPath;
		const slug = slugify(stripHomePrefix(path));
		return `${kind}-${slug === "" ? "home" : slug}`;
	}
	return slugify(input.scopeId);
};

const logicalName = (input: RenderAgentInput): string =>
	input.agent === "pandora"
		? "pdx--pandora"
		: `pdx--${input.agent}__${scopeSlug(input)}--${input.sessionId.slice(0, 8)}`;

const claudeProjectSlug = (cwd: string): string => cwd.replace(/[/:\\]/g, "-");

const piSessionBucket = (cwd: string): string =>
	`--${cwd.replace(/^\/+/, "").replace(/[/:\\]/g, "-")}--`;

const sessionLogPathFor = (
	input: { readonly cwd: string; readonly sessionId: string },
	harnessKind: HarnessKind,
): string =>
	harnessKind === "claude"
		? `${homedir()}/.claude/projects/${claudeProjectSlug(input.cwd)}/${input.sessionId}.jsonl`
		: `${homedir()}/.pi/agent/sessions/${piSessionBucket(input.cwd)}/${input.sessionId}.jsonl`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const launchErrorMessage = (context: string, error: unknown): string => {
	const message = error instanceof Error ? error.message : String(error);
	return `${context}: ${message}`;
};

const promptArgIndex = (rendered: RenderedAgent): number => {
	// findLastIndex so user argv containing --system-prompt/--append-system-prompt does not
	// shadow the Spawner-managed prompt, which is always placed after user argv.
	const index = rendered.harness.argv.findLastIndex(
		(arg) => arg === "--system-prompt" || arg === "--append-system-prompt",
	);
	if (index === -1 || rendered.harness.argv[index + 1] === undefined) {
		throw new SpawnerError({
			code: "LAUNCH_ERROR",
			message: `${rendered.harness.kind} harness argv is missing a system prompt argument`,
		});
	}
	return index + 1;
};

const hitlShellCommand = (rendered: RenderedAgent, services: LaunchServices): readonly string[] => {
	const promptIndex = promptArgIndex(rendered);
	const promptPath = services.writeTempText(
		"pithos-spawner-prompt",
		rendered.harness.argv[promptIndex]!,
	);
	const beforePrompt = rendered.harness.argv.slice(0, promptIndex).map(shellQuote).join(" ");
	const afterPrompt = rendered.harness.argv
		.slice(promptIndex + 1)
		.map(shellQuote)
		.join(" ");
	const script = [
		`prompt=$(cat ${shellQuote(promptPath)}) || exit $?`,
		`rm -f ${shellQuote(promptPath)}`,
		`exec ${beforePrompt} "$prompt"${afterPrompt === "" ? "" : ` ${afterPrompt}`}`,
	].join("; ");
	return ["sh", "-c", script];
};

const harnessArgv = (
	input: RenderAgentInput,
	manifest: Manifest,
	sessionLogPath: string,
	prompt: string,
): readonly string[] => {
	const promptFlag =
		manifest.harness.system_prompt_mode === "append" ? "--append-system-prompt" : "--system-prompt";
	const toolsArgs =
		manifest.harness.tools === undefined ? [] : ["--tools", manifest.harness.tools.join(",")];
	if (manifest.harness.kind === "claude") {
		const base = [
			"claude",
			...manifest.harness.argv,
			"--dangerously-skip-permissions",
			"--session-id",
			input.sessionId,
			"--model",
			manifest.harness.model,
			...toolsArgs,
			promptFlag,
			prompt,
		];
		return input.mode === "afk"
			? [...base, "--print", INITIAL_TASK_MESSAGE]
			: [...base, HITL_STARTUP_MESSAGE];
	}
	const base = [
		"pi",
		...manifest.harness.argv,
		"--session",
		sessionLogPath,
		"--model",
		manifest.harness.model,
		...toolsArgs,
		promptFlag,
		prompt,
	];
	return input.mode === "afk"
		? [...base, "--print", INITIAL_TASK_MESSAGE]
		: [...base, HITL_STARTUP_MESSAGE];
};

export const renderAgent = (
	input: RenderAgentInput,
	services: RenderServices = LiveSpawnerServices,
): RenderedAgent => {
	validateSessionId(input.sessionId);
	const manifest = loadManifests(services).find((item) => item.agent === input.agent);
	if (manifest === undefined)
		throw new SpawnerError({ code: "VALIDATION_ERROR", message: `unknown agent ${input.agent}` });
	if (manifest.mode !== input.mode)
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${input.agent} manifest mode ${manifest.mode} does not match requested mode ${input.mode}`,
		});
	const paths = templateAssetPaths(services);
	const config = loadConfig(services);
	const claim = claimForAgent(input.agent);
	const claims = BUILTIN_AGENT_CLAIMS[input.agent];
	const enqueues = BUILTIN_AGENT_ENQUEUES[input.agent];
	const includes = Object.fromEntries(
		manifest.includes.map((include) => [
			include,
			resolveWithOverlay(paths.extensionsTemplatesDir, paths.templatesDir, include, services),
		]),
	);
	const claimCommand = `pithos task claim --run ${input.runId} --scope ${input.scopeId} --capability ${claim}`;
	const commandCards = renderCommandCards(input.agent, services);
	const renderedTemplate = renderTemplate(
		resolveWithOverlay(
			paths.extensionsTemplatesDir,
			paths.templatesDir,
			manifest.template,
			services,
		),
		{
			...includes,
			agent: input.agent,
			run_id: input.runId,
			session_id: input.sessionId,
			scope_id: input.scopeId,
			cwd: input.cwd,
			claim_command: claimCommand,
			command_cards: commandCards,
			claims: claims.join(", "),
			enqueues: enqueues.join(", "),
			model: manifest.harness.model,
			tools_csv: manifest.harness.tools?.join(", ") ?? "",
		},
	);
	const appendTexts = manifest.appends.map((append) =>
		resolveWithOverlay(paths.extensionsTemplatesDir, paths.templatesDir, append, services),
	);
	const prompt =
		appendTexts.length > 0
			? `${renderedTemplate}\n\n---\n\n${appendTexts.join("\n\n---\n\n")}`
			: renderedTemplate;
	const env = {
		PITHOS_DB: config.pithosDb,
		PITHOS_RUN_ID: input.runId,
		PITHOS_SESSION_ID: input.sessionId,
		PITHOS_SCOPE_ID: input.scopeId,
		...(config.pdxDataDir === undefined ? {} : { PDX_DATA_DIR: config.pdxDataDir }),
	};
	const sessionLogPath = sessionLogPathFor(input, manifest.harness.kind);
	return {
		...input,
		logicalName: logicalName(input),
		harness: {
			kind: manifest.harness.kind,
			argv: harnessArgv(input, manifest, sessionLogPath, prompt),
			env,
		},
		sessionLogPath,
		prompt,
	};
};

export const launchRenderedAgent = (
	rendered: RenderedAgent,
	services: LaunchServices = LiveSpawnerServices,
): LaunchResult => {
	validateSessionId(rendered.sessionId);
	if (rendered.mode === "afk") {
		const file = rendered.harness.argv[0];
		if (file === undefined) {
			throw new SpawnerError({
				code: "LAUNCH_ERROR",
				message: `${rendered.agent}: rendered harness argv is empty`,
			});
		}
		let child: SpawnedProcess;
		try {
			child = services.spawnProcess(file, rendered.harness.argv.slice(1), {
				cwd: rendered.cwd,
				env: rendered.harness.env,
			});
			child.once?.("error", () => undefined);
		} catch (error) {
			throw new SpawnerError({
				code: "LAUNCH_ERROR",
				message: launchErrorMessage(`${rendered.agent}: failed to spawn ${file}`, error),
			});
		}
		if (child.pid === undefined)
			throw new SpawnerError({
				code: "LAUNCH_ERROR",
				message: `${rendered.agent}: failed to spawn ${file} in ${rendered.cwd}: process did not report pid`,
			});
		return {
			agent: rendered.agent,
			mode: rendered.mode,
			runId: rendered.runId,
			sessionId: rendered.sessionId,
			scopeId: rendered.scopeId,
			logicalName: rendered.logicalName,
			harnessKind: rendered.harness.kind,
			sessionLogPath: rendered.sessionLogPath,
			afk: { pid: child.pid, processStartTime: new Date().toISOString() },
		};
	}
	if (rendered.harness.argv.length === 0) {
		throw new SpawnerError({
			code: "LAUNCH_ERROR",
			message: `${rendered.agent}: rendered harness argv is empty`,
		});
	}
	const launchArgv = hitlShellCommand(rendered, services);
	const envCommand = [
		"env",
		...Object.entries(rendered.harness.env).map(([key, value]) => `${key}=${value}`),
		...launchArgv,
	];
	const result = services.execFile("tmux", [
		"new-session",
		"-d",
		"-s",
		rendered.logicalName,
		"-c",
		rendered.cwd,
		...envCommand,
	]);
	if (result.status !== 0)
		throw new SpawnerError({
			code: "LAUNCH_ERROR",
			message: `tmux new-session failed: ${result.stderr}`,
		});
	const pane = services.execFile("tmux", [
		"list-panes",
		"-t",
		rendered.logicalName,
		"-F",
		"#{pane_pid}",
	]);
	const pid = decodePanePid(pane.stdout, rendered.logicalName);
	return {
		agent: rendered.agent,
		mode: rendered.mode,
		runId: rendered.runId,
		sessionId: rendered.sessionId,
		scopeId: rendered.scopeId,
		logicalName: rendered.logicalName,
		harnessKind: rendered.harness.kind,
		sessionLogPath: rendered.sessionLogPath,
		hitl: { tmuxTarget: rendered.logicalName, panePid: pid },
	};
};

export const launchAgent = (
	input: RenderAgentInput,
	services: LaunchServices = LiveSpawnerServices,
): LaunchResult => launchRenderedAgent(renderAgent(input, services), services);

type JsonRecord = Readonly<Record<string, unknown>>;
interface TranscriptMessage {
	readonly ts: string;
	readonly role: string;
	readonly text: string;
}

const parseJsonl = (path: string, raw: string): readonly JsonRecord[] =>
	raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line, index) => {
			try {
				const parsed = JSON.parse(line) as unknown;
				if (isRecord(parsed)) return parsed;
			} catch (error) {
				throw new SpawnerError({
					code: "HARNESS_ERROR",
					message: `${path}:${index + 1}: invalid JSONL: ${String(error)}`,
				});
			}
			throw new SpawnerError({
				code: "HARNESS_ERROR",
				message: `${path}:${index + 1}: JSONL entry is not an object`,
			});
		});

const harnessError = (path: string, line: number, message: string): SpawnerError =>
	new SpawnerError({ code: "HARNESS_ERROR", message: `${path}:${line}: ${message}` });

const requiredString = (value: unknown, path: string, line: number, field: string): string => {
	if (typeof value === "string") return value;
	throw harnessError(path, line, `required ${field} must be a string`);
};

const requiredRecord = (value: unknown, path: string, line: number, field: string): JsonRecord => {
	if (isRecord(value)) return value;
	throw harnessError(path, line, `required ${field} must be an object`);
};

const fmtTs = (value: unknown, path: string, line: number): string =>
	requiredString(value, path, line, "timestamp").slice(0, 19).replace("T", " ");

const contentArray = (
	content: unknown,
	path: string,
	line: number,
	field: string,
): readonly JsonRecord[] => {
	if (!Array.isArray(content)) {
		throw harnessError(path, line, `required ${field} must be an array`);
	}
	return content.map((item, index) =>
		requiredRecord(item, path, line, `${field}[${index.toString()}]`),
	);
};

const textFromClaudeContent = (content: unknown, path: string, line: number): string => {
	if (typeof content === "string") return content;
	const blocks = contentArray(content, path, line, "message.content");
	const text = blocks
		.filter((item) => item.type === "text")
		.map((item) => requiredString(item.text, path, line, "message.content[].text"))
		.join("\n");
	if (text.length > 0) return text;
	const tools = blocks
		.filter((item) => item.type === "tool_use")
		.map((item) => requiredString(item.name, path, line, "message.content[].name"));
	return tools.length > 0 ? `[tools: ${tools.join(", ")}]` : "";
};

const textFromPiUserContent = (content: unknown, path: string, line: number): string => {
	if (typeof content === "string") return content;
	return contentArray(content, path, line, "message.content")
		.filter((item) => item.type === "text")
		.map((item) => requiredString(item.text, path, line, "message.content[].text"))
		.join("\n");
};

const textFromPiAssistantContent = (content: unknown, path: string, line: number): string => {
	const blocks = contentArray(content, path, line, "message.content");
	const text = blocks
		.flatMap((item) => {
			if (item.type === "text") {
				return [requiredString(item.text, path, line, "message.content[].text")];
			}
			if (item.type === "thinking") {
				return [requiredString(item.thinking, path, line, "message.content[].thinking")];
			}
			return [];
		})
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join("\n");
	if (text.length > 0) return text;
	const tools = blocks
		.filter((item) => item.type === "toolCall")
		.map((item) => requiredString(item.name, path, line, "message.content[].name"));
	return tools.length > 0 ? `[tools: ${tools.join(", ")}]` : "";
};

const parseClaudeTranscript = (path: string, raw: string): readonly TranscriptMessage[] =>
	parseJsonl(path, raw).flatMap((entry, index) => {
		const line = index + 1;
		if (entry.type !== "user" && entry.type !== "assistant") return [];
		const message = requiredRecord(entry.message, path, line, "message");
		const text = textFromClaudeContent(message.content, path, line);
		if (text.length === 0) return [];
		return [{ ts: fmtTs(entry.timestamp, path, line), role: entry.type.toUpperCase(), text }];
	});

const parsePiTranscript = (path: string, raw: string): readonly TranscriptMessage[] =>
	parseJsonl(path, raw).flatMap((entry, index) => {
		const line = index + 1;
		if (entry.type !== "message") return [];
		const message = requiredRecord(entry.message, path, line, "message");
		const role = requiredString(message.role, path, line, "message.role");
		if (role !== "user" && role !== "assistant") return [];
		const text =
			role === "user"
				? textFromPiUserContent(message.content, path, line)
				: textFromPiAssistantContent(message.content, path, line);
		if (text.length === 0) return [];
		return [{ ts: fmtTs(entry.timestamp, path, line), role: role.toUpperCase(), text }];
	});

const formatTranscript = (messages: readonly TranscriptMessage[], limit: number): string =>
	messages
		.slice(-limit)
		.map((message) => {
			const oneLine = message.text.replace(/\s+/g, " ").trim();
			const snippet = oneLine.length > 400 ? oneLine.slice(0, 400) : oneLine;
			return `[${message.ts}] ${message.role}: ${snippet}`;
		})
		.join("\n");

const RenderSessionTranscriptLimitSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const renderSessionTranscript = (
	input: RenderSessionTranscriptInput,
	services: RenderServices = LiveSpawnerServices,
): string => {
	const manifest = decode(
		Schema.Struct({
			harnessKind: HarnessKindSchema,
			sessionLogPath: Schema.NonEmptyString,
			limit: Schema.optional(RenderSessionTranscriptLimitSchema),
		}),
		input,
		"renderSessionTranscript",
	);
	let raw: string;
	try {
		raw = services.readText(manifest.sessionLogPath);
	} catch (error) {
		throw new SpawnerError({
			code: "HARNESS_ERROR",
			message: `${manifest.sessionLogPath}: failed to read session log: ${String(error)}`,
		});
	}
	const messages =
		manifest.harnessKind === "claude"
			? parseClaudeTranscript(manifest.sessionLogPath, raw)
			: parsePiTranscript(manifest.sessionLogPath, raw);
	return `${formatTranscript(messages, manifest.limit ?? 20)}\n`;
};
