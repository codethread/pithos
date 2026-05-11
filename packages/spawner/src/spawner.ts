import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	BUILTIN_AGENT_CLAIMS,
	BUILTIN_AGENT_ENQUEUES,
	BUILTIN_SPAWNABLE_AGENT_KINDS,
	type Capability,
	type SpawnableAgentKind,
} from "@pithos/pithos/builtins";
import { Either, ParseResult, Schema } from "effect";
import { SpawnerError } from "./errors.js";
import { agentsPath, templatesDir } from "./paths.js";
import { LiveSpawnerServices, type LaunchServices, type RenderServices } from "./services.js";

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
});

const ManifestSchema = Schema.Struct({
	agent: AgentKindSchema,
	mode: ModeSchema,
	claims: Schema.Array(Schema.Literal("triage", "design", "execute", "escalate")).pipe(
		Schema.minItems(1),
	),
	enqueues: Schema.Array(Schema.Literal("triage", "design", "execute", "escalate")),
	harness: HarnessSchema,
	includes: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), { default: () => [] }),
	template: Schema.NonEmptyString,
});
const AgentsFileSchema = Schema.Struct({ agents: Schema.Array(ManifestSchema) });
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

const loadManifests = (services: RenderServices = LiveSpawnerServices): readonly Manifest[] => {
	const parsed = decode(
		Schema.parseJson(AgentsFileSchema),
		readText(agentsPath, services),
		agentsPath,
	);
	for (const manifest of parsed.agents) validateManifestContract(manifest);
	return parsed.agents;
};

const validateManifestContract = (manifest: Manifest): void => {
	const expectedClaims = BUILTIN_AGENT_CLAIMS[manifest.agent];
	const expectedEnqueues = BUILTIN_AGENT_ENQUEUES[manifest.agent];
	if (manifest.claims.length !== 1) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${manifest.agent}: MVP requires exactly one claim capability`,
		});
	}
	if (!arrayEqual(manifest.claims, expectedClaims)) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${manifest.agent}: manifest claims ${manifest.claims.join(",")} do not match built-in contract ${expectedClaims.join(",")}`,
		});
	}
	if (!arrayEqual(manifest.enqueues, expectedEnqueues)) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${manifest.agent}: manifest enqueues ${manifest.enqueues.join(",")} do not match built-in contract ${expectedEnqueues.join(",")}`,
		});
	}
	for (const include of manifest.includes) {
		if (basename(include) !== include) {
			throw new SpawnerError({
				code: "VALIDATION_ERROR",
				message: `${manifest.agent}: include must be a template basename: ${include}`,
			});
		}
	}
	const includeSet = new Set(manifest.includes);
	if (includeSet.size !== manifest.includes.length) {
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${manifest.agent}: includes must be unique template basenames`,
		});
	}
};

const arrayEqual = (left: readonly Capability[], right: readonly Capability[]): boolean =>
	left.length === right.length && left.every((value, index) => value === right[index]);

const renderTemplate = (template: string, ctx: Record<string, string>): string =>
	template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
		if (!(key in ctx))
			throw new SpawnerError({ code: "TEMPLATE_ERROR", message: `Unknown template var: ${key}` });
		return ctx[key] ?? "";
	});

const SpawnerConfigSchema = Schema.Struct({
	pithosBin: Schema.NonEmptyString,
	pithosDb: Schema.NonEmptyString,
	pdxBin: Schema.NonEmptyString,
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
			pithosBin: services.env("PITHOS_BIN") ?? "pithos",
			pithosDb,
			pdxBin: services.env("PDX_BIN") ?? "pdx",
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
	toil: ["pithos task"],
	greed: ["pithos task"],
	pandora: ["pithos task", "pithos graph", "pithos events", "pithos briefing"],
};

const PANDORA_PDX_COMMAND_PATHS = ["pdx run transcript"] as const;

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

const pithosHelpTree = (config: SpawnerConfig, services: RenderServices): CommandHelpCard => {
	const result = services.execFile(config.pithosBin, ["--help"]);
	if (result.status !== 0) {
		throw new SpawnerError({
			code: "TEMPLATE_ERROR",
			message: `${config.pithosBin} --help failed: ${result.stderr}`,
		});
	}
	return parseCommandHelpTree(result.stdout, "pithos help");
};

const pdxHelpTree = (config: SpawnerConfig, services: RenderServices): CommandHelpCard => {
	const result = services.execFile(config.pdxBin, ["--help-json"]);
	if (result.status !== 0) {
		throw new SpawnerError({
			code: "TEMPLATE_ERROR",
			message: `${config.pdxBin} --help-json failed: ${result.stderr}`,
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

const renderCommandCards = (
	agent: SpawnableAgentKind,
	config: SpawnerConfig,
	services: RenderServices,
): string => {
	const pithosHelp = filteredHelpTree(
		pithosHelpTree(config, services),
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
		const pdxHelp = filteredHelpTree(
			pdxHelpTree(config, services),
			PANDORA_PDX_COMMAND_PATHS,
			"pdx help",
		);
		sections.push(
			["### pdx inspection help JSON", "```json", renderCommandHelpJson(pdxHelp), "```"].join("\n"),
		);
	}
	return `${sections.join("\n\n")}\n`;
};

const logicalName = (input: RenderAgentInput): string =>
	input.agent === "pandora"
		? "pdx--pandora"
		: `pdx--${input.agent}__${input.scopeId.replace(/[^a-zA-Z0-9]+/g, "-")}--${input.sessionId.slice(0, 8)}`;

const claudeProjectSlug = (cwd: string): string => cwd.replace(/^\/+/, "").replace(/[/:\\]/g, "-");

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

const piPromptArgIndex = (argv: readonly string[]): number => {
	const index = argv.findIndex(
		(arg) => arg === "--system-prompt" || arg === "--append-system-prompt",
	);
	if (index === -1 || argv[index + 1] === undefined) {
		throw new SpawnerError({
			code: "LAUNCH_ERROR",
			message: "pi harness argv is missing a system prompt argument",
		});
	}
	return index + 1;
};

const piHitlShellCommand = (
	rendered: RenderedAgent,
	services: LaunchServices,
): readonly string[] => {
	const promptIndex = piPromptArgIndex(rendered.harness.argv);
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
		`exec ${beforePrompt} \"$prompt\"${afterPrompt === "" ? "" : ` ${afterPrompt}`}`,
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
			"--session-id",
			input.sessionId,
			"--model",
			manifest.harness.model,
			...toolsArgs,
			promptFlag,
			prompt,
		];
		return input.mode === "afk" ? [...base, "--print", INITIAL_TASK_MESSAGE] : base;
	}
	const base = [
		"pi",
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
	const config = loadConfig(services);
	const claim = manifest.claims[0];
	if (claim === undefined)
		throw new SpawnerError({
			code: "VALIDATION_ERROR",
			message: `${input.agent}: missing claim capability`,
		});
	const includes = Object.fromEntries(
		manifest.includes.map((include) => [include, readText(join(templatesDir, include), services)]),
	);
	const claimCommand = `${config.pithosBin} task claim --run ${input.runId} --scope ${input.scopeId} --capability ${claim}`;
	const commandCards = renderCommandCards(input.agent, config, services);
	const prompt = renderTemplate(readText(join(templatesDir, manifest.template), services), {
		...includes,
		agent: input.agent,
		run_id: input.runId,
		session_id: input.sessionId,
		scope_id: input.scopeId,
		cwd: input.cwd,
		claim_command: claimCommand,
		command_cards: commandCards,
		claims: manifest.claims.join(", "),
		enqueues: manifest.enqueues.join(", "),
		model: manifest.harness.model,
		tools_csv: manifest.harness.tools?.join(", ") ?? "",
	});
	const env = {
		PITHOS_DB: config.pithosDb,
		PITHOS_RUN_ID: input.runId,
		PITHOS_SESSION_ID: input.sessionId,
		PITHOS_SCOPE_ID: input.scopeId,
		PITHOS_BIN: config.pithosBin,
		PDX_BIN: config.pdxBin,
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
		const child = services.spawnProcess(file, rendered.harness.argv.slice(1), {
			cwd: rendered.cwd,
			env: rendered.harness.env,
		});
		if (child.pid === undefined)
			throw new SpawnerError({
				code: "LAUNCH_ERROR",
				message: `${rendered.agent}: harness process did not report pid`,
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
	const launchArgv =
		rendered.harness.kind === "pi" ? piHitlShellCommand(rendered, services) : rendered.harness.argv;
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
