import { homedir } from "node:os";
import {
	BUILTIN_AGENT_CLAIMS,
	BUILTIN_AGENT_ENQUEUES,
	BUILTIN_SPAWNABLE_AGENT_KINDS,
	type Capability,
	type SpawnableAgentKind,
} from "@pdx/pithos/builtins";
import { Either, ParseResult, Schema } from "effect";
import { SpawnerError } from "./errors.js";
import {
	loadResolvedAgentConfig,
	loadResolvedHooks,
	resolveTemplateAsset,
	type HooksConfig,
	type ResolvedAgentManifest,
	type ResolvedTemplateAsset,
} from "./manifest.js";
import { resolveUserDataDir } from "./paths.js";
import {
	LiveSpawnerServices,
	type LaunchServices,
	type RenderServices,
	type SpawnedProcess,
} from "./services.js";

export const AgentKindSchema = Schema.Literal(...BUILTIN_SPAWNABLE_AGENT_KINDS);
export const ModeSchema = Schema.Literal("afk", "hitl");

interface RenderAgentInputBase {
	readonly mode: "afk" | "hitl";
	readonly runId: string;
	readonly sessionId: string;
	readonly scopeId: string;
	readonly cwd: string;
	readonly parentRepoPath?: string;
}

type GreedClaimCapability = (typeof BUILTIN_AGENT_CLAIMS.greed)[number];
type SingleClaimAgent = Exclude<SpawnableAgentKind, "greed">;

export type RenderAgentInput =
	| (RenderAgentInputBase & {
			readonly agent: "greed";
			readonly selectedCapability: GreedClaimCapability;
	  })
	| (RenderAgentInputBase & {
			readonly agent: SingleClaimAgent;
			readonly selectedCapability?: never;
	  });

const HarnessKindSchema = Schema.Literal("claude", "pi");
export type HarnessKind = Schema.Schema.Type<typeof HarnessKindSchema>;

interface RenderedAgentFields {
	readonly logicalName: string;
	readonly harness: {
		readonly kind: HarnessKind;
		readonly argv: readonly string[];
		readonly env: Record<string, string>;
	};
	readonly sessionLogPath: string;
	readonly prompt: string;
	readonly provenance?: {
		readonly layers: readonly {
			readonly kind: "bundled" | "user" | "user-scope" | "project" | "project-scope";
			readonly scopeKind: "global" | "repo" | "worktree";
			readonly rootDir: string;
			readonly agentsPath: string;
		}[];
		readonly template: {
			readonly reference: string;
			readonly pinnedToBundled: boolean;
			readonly resolved: TemplateProvenance;
		};
		readonly includes: readonly TemplateProvenance[];
		readonly appends: readonly TemplateProvenance[];
	};
}

export type RenderedAgent = RenderAgentInput & RenderedAgentFields;

interface TemplateProvenance {
	readonly reference: string;
	readonly path: string;
	readonly source:
		| { readonly type: "absolute" | "home" }
		| {
				readonly type: "layer";
				readonly kind: "bundled" | "user" | "user-scope" | "project" | "project-scope";
				readonly scopeKind: "global" | "repo" | "worktree";
				readonly rootDir: string;
		  };
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

export type { HooksConfig } from "./manifest.js";

export const loadHooks = (services: RenderServices = LiveSpawnerServices): HooksConfig =>
	loadResolvedHooks(services);

const claimForAgent = (
	agent: SpawnableAgentKind,
	selectedCapability: Capability | undefined,
): string => {
	const claims = BUILTIN_AGENT_CLAIMS[agent];
	if (claims.length === 1) {
		const [claim] = claims;
		if (selectedCapability !== undefined) {
			throw new SpawnerError({
				code: "VALIDATION_ERROR",
				message: `${agent}: selectedCapability is only valid for multi-claim render`,
			});
		}
		return claim;
	}
	if (selectedCapability === undefined) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${agent}: selectedCapability is required for multi-claim render`,
		});
	}
	if (!(claims as readonly string[]).includes(selectedCapability)) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${agent}: selected capability ${selectedCapability} is not authorized`,
		});
	}
	return selectedCapability;
};

const renderTemplate = (template: string, ctx: Record<string, string>): string =>
	template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_match, key: string) => {
		if (!(key in ctx))
			throw new SpawnerError({ code: "TEMPLATE_ERROR", message: `Unknown template var: ${key}` });
		return ctx[key] ?? "";
	});

const SpawnerConfigSchema = Schema.Struct({
	pithosDb: Schema.NonEmptyString,
	pdxDataDir: Schema.optional(Schema.NonEmptyString),
	pdxUserDataDir: Schema.optional(Schema.NonEmptyString),
});

const INITIAL_TASK_MESSAGE = "Claim and process one task, then exit.";
const HITL_STARTUP_MESSAGE = "begin";

type SpawnerConfig = Schema.Schema.Type<typeof SpawnerConfigSchema>;

const loadConfig = (services: RenderServices): SpawnerConfig => {
	const dataDir = services.env("PDX_DATA_DIR");
	const pdxUserDataDir = resolveUserDataDir(dataDir, services.env("PDX_USER_DATA_DIR"));
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
		{ pithosDb, pdxDataDir: dataDir, pdxUserDataDir },
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

const PITHOS_COMMAND_ANNOTATIONS: Readonly<Record<string, readonly string[]>> = {
	"pithos task claim": [
		"Use the rendered claim command above instead of reconstructing it by hand.",
	],
	"pithos task inspect": [
		"Readable Markdown is the normal task context.",
		"Use `--json` only for exact fields, scripting, or lost-token recovery.",
	],
	"pithos task artifact add": [
		"Use `--stdin` with a quoted heredoc (`<<'EOF'`) for artifact body content.",
	],
	"pithos task complete": [
		"Default completion sends no stdin and records empty metadata.",
		"Use `--stdin` only for JSON object metadata.",
	],
	"pithos task fail": [
		"Include a concise reason plus relevant evidence in an artifact or the reason text.",
	],
	"pithos task enqueue": [
		"Omit `--chain` for ordinary follow-up on the current task chain.",
		"Use `--chain none` only for intentionally unrelated work or manual graph repair.",
	],
	"pithos task supersede": ["Use for graph repair/replacement, not normal successful completion."],
	"pithos task cancel": ["Use to abandon non-held work, not normal successful completion."],
	"pithos briefing": [
		"Owns agenda-style ready/blocked summaries and user-facing next actions.",
		"Run `pithos briefing --agent pandora` before broad graph interrogation for sitrep.",
	],
	"pithos graph inspect": [
		"Use for task inventory, edge/gate shape, provenance, audit questions, and drill-down task ids.",
		"`--task`, `--scope`, and `--all` are mutually exclusive selectors.",
		"Repeat `--status` to OR literal task statuses; repeat `--search` to AND terms over task title/body only.",
		"`--since` accepts `today`, `<n>h`, `<n>d`, `YYYY-MM-DD`, and ISO timestamps with timezone.",
		"Filters narrow seed selection before graph closure; closure may include related non-matching tasks so blockers, attached context, gates, and supersessions remain understandable.",
		"Readable output is the normal agent surface; use `--json` for typed-edge details, exact fields, or scripting.",
		"Scope graph views can include global `about`/`repair`/checkpoint context attached to selected scoped work.",
	],
};

const PDX_COMMAND_ANNOTATIONS: Readonly<Record<string, readonly string[]>> = {
	"pdx daemon status": [
		"Use for liveness questions or when graph/transcript evidence conflicts; it is not the normal sitrep source of truth.",
	],
	"pdx daemon logs": [
		"Supervisor logs are for launch, kill, reconcile, and daemon debugging; they are not agent transcripts.",
	],
	"pdx run transcript": [
		"Normal cross-harness inspection surface for AFK and HITL runs.",
		"A quiet transcript does not prove the run exited; the agent may be inside a long-running tool call.",
	],
	"pdx run show": [
		"Navigation only: jumps to an interactive session when one exists.",
		"AFK runs are headless and intentionally have no session to show.",
	],
	"pdx task show": [
		"Navigation only: jumps to the interactive holder run for a task when one exists.",
	],
};

const PITHOS_TOP_LEVEL_PATHS: Record<SpawnableAgentKind, readonly string[]> = {
	war: ["pithos task"],
	toil: ["pithos scope", "pithos task"],
	greed: ["pithos scope", "pithos task"],
	pandora: ["pithos scope", "pithos task", "pithos graph", "pithos events", "pithos briefing"],
	envy: ["pithos scope", "pithos task"],
};

const PANDORA_PDX_COMMAND_PATHS = [
	"pdx daemon status",
	"pdx daemon logs",
	"pdx run transcript",
	"pdx run show",
	"pdx task show",
] as const;

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

const leafCommandCards = (tree: CommandHelpCard): readonly CommandHelpCard[] => {
	const visit = (card: CommandHelpCard): readonly CommandHelpCard[] => {
		if (card.subcommands.length === 0) return [card];
		return card.subcommands.flatMap((child) => visit(child));
	};
	return tree.subcommands.flatMap((child) => visit(child));
};

const fullUsage = (card: CommandHelpCard): string => {
	if (card.usage === card.path || card.usage.startsWith(`${card.path} `)) return card.usage;
	if (card.usage === card.name) return card.path;
	if (card.usage.startsWith(`${card.name} `))
		return `${card.path} ${card.usage.slice(card.name.length + 1)}`;
	return `${card.path} ${card.usage}`;
};

const validateCommandAnnotations = (
	tree: CommandHelpCard,
	annotations: Readonly<Record<string, readonly string[]>>,
): void => {
	const commandPaths = flattenHelpTree(tree);
	for (const path of Object.keys(annotations)) {
		if (!commandPaths.has(path)) {
			throw new SpawnerError({
				code: "TEMPLATE_ERROR",
				message: `command annotation references unknown generated help path: ${path}`,
			});
		}
	}
};

const annotationLines = (path: string): readonly string[] => {
	const notes = PITHOS_COMMAND_ANNOTATIONS[path] ?? PDX_COMMAND_ANNOTATIONS[path];
	if (notes === undefined) return [];
	return ["", "Notes:", "", ...notes.map((note) => `- ${note}`)];
};

const renderCommandHelpMarkdown = (title: string, tree: CommandHelpCard): string => {
	const leaves = leafCommandCards(tree);
	return [
		`### ${title}`,
		...leaves.flatMap((card) => [
			"",
			`#### \`${card.path}\``,
			"",
			card.description,
			"",
			"Usage:",
			"",
			"```sh",
			fullUsage(card),
			"```",
			...annotationLines(card.path),
		]),
	].join("\n");
};

const renderCommandCards = (agent: SpawnableAgentKind, services: RenderServices): string => {
	const rawPithosHelp = pithosHelpTree(services);
	validateCommandAnnotations(rawPithosHelp, PITHOS_COMMAND_ANNOTATIONS);
	const pithosHelp = filteredHelpTree(rawPithosHelp, PITHOS_TOP_LEVEL_PATHS[agent], "pithos help");
	const sections = [
		[
			"## Generated command reference",
			"This reference is generated from CLI metadata. Use the rendered claim command above for the exact claim invocation for this run.",
			"",
			renderCommandHelpMarkdown("Pithos", pithosHelp),
		].join("\n"),
	];
	if (agent === "pandora") {
		const rawPdxHelp = pdxHelpTree(services);
		const pdxHelp = filteredHelpTree(rawPdxHelp, PANDORA_PDX_COMMAND_PATHS, "pdx help");
		validateCommandAnnotations(rawPdxHelp, PDX_COMMAND_ANNOTATIONS);
		sections.push(renderCommandHelpMarkdown("pdx inspection", pdxHelp));
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

const claudeProjectSlug = (cwd: string, services: RenderServices): string =>
	services.realPath(cwd).replace(/[^A-Za-z0-9-]/g, "-");

const piSessionBucket = (cwd: string): string =>
	`--${cwd.replace(/^\/+/, "").replace(/[/:\\]/g, "-")}--`;

const sessionLogPathFor = (
	input: { readonly cwd: string; readonly sessionId: string },
	harnessKind: HarnessKind,
	services: RenderServices,
): string =>
	harnessKind === "claude"
		? `${homedir()}/.claude/projects/${claudeProjectSlug(input.cwd, services)}/${input.sessionId}.jsonl`
		: `${homedir()}/.pi/agent/sessions/${piSessionBucket(input.cwd)}/${input.sessionId}.jsonl`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

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

const templateProvenance = (asset: ResolvedTemplateAsset): TemplateProvenance => ({
	reference: asset.reference,
	path: asset.path,
	source: asset.layer,
});

const harnessArgv = (
	input: RenderAgentInput,
	manifest: ResolvedAgentManifest,
	sessionLogPath: string,
	prompt: string,
): readonly string[] => {
	const promptFlag =
		manifest.harness.system_prompt_mode === "append" ? "--append-system-prompt" : "--system-prompt";
	const toolsArgs =
		manifest.harness.kind === "claude"
			? [
					"--tools",
					manifest.harness.tools === undefined || manifest.harness.tools.length === 0
						? "default"
						: manifest.harness.tools.join(","),
				]
			: manifest.harness.tools === undefined || manifest.harness.tools.length === 0
				? []
				: ["--tools", manifest.harness.tools.join(",")];
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
	const config = loadConfig(services);
	const resolved = loadResolvedAgentConfig(input, services);
	const manifest = resolved.agents[input.agent];
	if (manifest === undefined) {
		throw new SpawnerError({ code: "VALIDATION_ERROR", message: `unknown agent ${input.agent}` });
	}
	const expectedMode = input.agent === "pandora" || input.agent === "greed" ? "hitl" : "afk";
	if (input.mode !== expectedMode) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${input.agent} manifest mode ${expectedMode} does not match requested mode ${input.mode}`,
		});
	}
	const claim = claimForAgent(input.agent, input.selectedCapability);
	const claims = BUILTIN_AGENT_CLAIMS[input.agent];
	const enqueues = BUILTIN_AGENT_ENQUEUES[input.agent];
	const includeAssets = manifest.includes.map((include) =>
		resolveTemplateAsset(include, resolved, services),
	);
	const includes = Object.fromEntries(
		includeAssets.map((includeAsset) => [includeAsset.reference, includeAsset.content]),
	);
	const claimCommand = `pithos task claim --run ${input.runId} --scope ${input.scopeId} --capability ${claim}`;
	const commandCards = renderCommandCards(input.agent, services);
	const templateAsset = resolveTemplateAsset(manifest.template, resolved, services, {
		pinToBundled: manifest.templatePinnedToBundled,
	});
	const renderedTemplate = renderTemplate(templateAsset.content, {
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
	});
	const appendAssets = manifest.appends.map((append) =>
		resolveTemplateAsset(append, resolved, services),
	);
	const appendTexts = appendAssets.map((appendAsset) => appendAsset.content);
	const prompt =
		appendTexts.length > 0
			? `${renderedTemplate}\n\n---\n\n${appendTexts.join("\n\n---\n\n")}`
			: renderedTemplate;
	const env = {
		PITHOS_DB: config.pithosDb,
		PITHOS_RUN_ID: input.runId,
		PITHOS_SESSION_ID: input.sessionId,
		PITHOS_SCOPE_ID: input.scopeId,
		...(input.parentRepoPath === undefined
			? {}
			: { PITHOS_PARENT_REPO_PATH: input.parentRepoPath }),
		...(config.pdxDataDir === undefined ? {} : { PDX_DATA_DIR: config.pdxDataDir }),
		...(config.pdxUserDataDir === undefined ? {} : { PDX_USER_DATA_DIR: config.pdxUserDataDir }),
	};
	const sessionLogPath = sessionLogPathFor(input, manifest.harness.kind, services);
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
		provenance: {
			layers: resolved.layers.map((layer) => ({
				kind: layer.kind,
				scopeKind: layer.scopeKind,
				rootDir: layer.rootDir,
				agentsPath: layer.agentsPath,
			})),
			template: {
				reference: manifest.template,
				pinnedToBundled: manifest.templatePinnedToBundled,
				resolved: templateProvenance(templateAsset),
			},
			includes: includeAssets.map(templateProvenance),
			appends: appendAssets.map(templateProvenance),
		},
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
			const message = error instanceof Error ? error.message : String(error);
			throw new SpawnerError({
				code: "LAUNCH_ERROR",
				message: `${rendered.agent}: failed to spawn ${file}: ${message}`,
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

const PI_TOOL_TIMELINE_ENTRY_TYPE = "timeline-timestamps-tool-call";

const textFromPiToolTimeline = (entry: JsonRecord, path: string, line: number): string => {
	const data = isRecord(entry.data) ? entry.data : entry;
	const toolName = requiredString(data.toolName, path, line, "data.toolName").trim();
	if (toolName.length === 0)
		throw harnessError(path, line, "required data.toolName must be non-empty");
	const preview = typeof data.preview === "string" ? data.preview.trim() : "";
	return preview.length > 0
		? `[tool in flight: ${toolName} — ${preview}]`
		: `[tool in flight: ${toolName}]`;
};

const parsePiTranscript = (path: string, raw: string): readonly TranscriptMessage[] =>
	parseJsonl(path, raw).flatMap((entry, index) => {
		const line = index + 1;
		if (entry.type === "message") {
			const message = requiredRecord(entry.message, path, line, "message");
			const role = requiredString(message.role, path, line, "message.role");
			if (role !== "user" && role !== "assistant") return [];
			const text =
				role === "user"
					? textFromPiUserContent(message.content, path, line)
					: textFromPiAssistantContent(message.content, path, line);
			if (text.length === 0) return [];
			return [{ ts: fmtTs(entry.timestamp, path, line), role: role.toUpperCase(), text }];
		}
		if (
			entry.type === PI_TOOL_TIMELINE_ENTRY_TYPE ||
			(entry.type === "custom" && entry.customType === PI_TOOL_TIMELINE_ENTRY_TYPE)
		) {
			return [
				{
					ts: fmtTs(entry.timestamp, path, line),
					role: "ASSISTANT",
					text: textFromPiToolTimeline(entry, path, line),
				},
			];
		}
		return [];
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
	if (messages.length === 0) {
		throw new SpawnerError({
			code: "HARNESS_ERROR",
			message: `${manifest.sessionLogPath}: no ${manifest.harnessKind} transcript messages found`,
		});
	}
	return `${formatTranscript(messages, manifest.limit ?? 20)}\n`;
};
