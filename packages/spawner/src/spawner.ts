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
		},
		"SpawnerConfig",
	);
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
	const prompt = renderTemplate(readText(join(templatesDir, manifest.template), services), {
		...includes,
		agent: input.agent,
		run_id: input.runId,
		session_id: input.sessionId,
		scope_id: input.scopeId,
		cwd: input.cwd,
		claim_command: claimCommand,
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
	const envCommand = [
		"env",
		...Object.entries(rendered.harness.env).map(([key, value]) => `${key}=${value}`),
		...rendered.harness.argv,
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

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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

const fmtTs = (value: unknown): string =>
	typeof value === "string" ? value.slice(0, 19).replace("T", " ") : "";

const textFromClaudeContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const text = content
		.filter(isRecord)
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("\n");
	if (text.length > 0) return text;
	const tools = content
		.filter(isRecord)
		.filter((item) => item.type === "tool_use" && typeof item.name === "string")
		.map((item) => item.name as string);
	return tools.length > 0 ? `[tools: ${tools.join(", ")}]` : "";
};

const textFromPiUserContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isRecord)
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("\n");
};

const textFromPiAssistantContent = (content: unknown): string => {
	if (!Array.isArray(content)) return "";
	const text = content
		.filter(isRecord)
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("\n");
	if (text.length > 0) return text;
	const tools = content
		.filter(isRecord)
		.filter((item) => item.type === "toolCall" && typeof item.name === "string")
		.map((item) => item.name as string);
	return tools.length > 0 ? `[tools: ${tools.join(", ")}]` : "";
};

const parseClaudeTranscript = (path: string, raw: string): readonly TranscriptMessage[] =>
	parseJsonl(path, raw).flatMap((entry) => {
		if (entry.type !== "user" && entry.type !== "assistant") return [];
		const message = entry.message;
		if (!isRecord(message)) return [];
		const text = textFromClaudeContent(message.content);
		if (text.length === 0) return [];
		return [{ ts: fmtTs(entry.timestamp), role: String(entry.type).toUpperCase(), text }];
	});

const parsePiTranscript = (path: string, raw: string): readonly TranscriptMessage[] =>
	parseJsonl(path, raw).flatMap((entry) => {
		if (entry.type !== "message") return [];
		const message = entry.message;
		if (!isRecord(message) || typeof message.role !== "string") return [];
		const text =
			message.role === "user"
				? textFromPiUserContent(message.content)
				: message.role === "assistant"
					? textFromPiAssistantContent(message.content)
					: "";
		if (text.length === 0) return [];
		return [{ ts: fmtTs(entry.timestamp), role: message.role.toUpperCase(), text }];
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
