import { join } from "node:path";
import {
	BUILTIN_AGENT_CLAIMS,
	BUILTIN_AGENT_ENQUEUES,
	BUILTIN_SPAWNABLE_AGENT_KINDS,
	type Capability,
	type SpawnableAgentKind,
} from "@pithos/pithos";
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

export interface RenderedAgent extends RenderAgentInput {
	readonly logicalName: string;
	readonly harness: {
		readonly kind: string;
		readonly argv: readonly string[];
		readonly env: Record<string, string>;
	};
	readonly prompt: string;
}

export interface LaunchResult {
	readonly agent: SpawnableAgentKind;
	readonly mode: "afk" | "hitl";
	readonly runId: string;
	readonly sessionId: string;
	readonly scopeId: string;
	readonly logicalName: string;
	readonly harnessKind: string;
	readonly sessionLogPath: string;
	readonly afk?: { readonly pid: number; readonly processStartTime: string };
	readonly hitl?: { readonly tmuxTarget: string; readonly panePid: number | null };
}

const ManifestSchema = Schema.Struct({
	agent: AgentKindSchema,
	mode: ModeSchema,
	claims: Schema.Array(Schema.Literal("triage", "design", "execute", "escalate")).pipe(
		Schema.minItems(1),
	),
	enqueues: Schema.Array(Schema.Literal("triage", "design", "execute", "escalate")),
	harness: Schema.Struct({ kind: Schema.Literal("claude", "pi") }),
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
	home: Schema.NonEmptyString,
});

type SpawnerConfig = Schema.Schema.Type<typeof SpawnerConfigSchema>;

const loadConfig = (services: RenderServices): SpawnerConfig =>
	decode(
		SpawnerConfigSchema,
		{ pithosBin: services.env("PITHOS_BIN") ?? "pithos", home: services.home() },
		"SpawnerConfig",
	);

const logicalName = (input: RenderAgentInput): string =>
	input.agent === "pandora"
		? "pdx--pandora"
		: `pdx--${input.agent}__${input.scopeId.replace(/[^a-zA-Z0-9]+/g, "-")}--${input.sessionId.slice(0, 8)}`;

const claudeProjectSlug = (cwd: string): string => cwd.replace(/^\/+/, "").replace(/[/:\\]/g, "-");

const piSessionBucket = (cwd: string): string =>
	`--${cwd.replace(/^\/+/, "").replace(/[/:\\]/g, "-")}--`;

const sessionLogPath = (
	input: RenderAgentInput,
	harnessKind: "claude" | "pi",
	config: SpawnerConfig,
): string =>
	harnessKind === "claude"
		? `${config.home}/.claude/projects/${claudeProjectSlug(input.cwd)}/${input.sessionId}.jsonl`
		: `${config.home}/.pi/agent/sessions/${piSessionBucket(input.cwd)}/${input.sessionId}.jsonl`;

export const renderAgent = (
	input: RenderAgentInput,
	services: RenderServices = LiveSpawnerServices,
): RenderedAgent => {
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
	const claimCommand = `${config.pithosBin} task claim --run ${input.runId} --scope ${input.scopeId} --capability ${claim}`;
	const prompt = renderTemplate(readText(join(templatesDir, manifest.template), services), {
		agent: input.agent,
		run_id: input.runId,
		session_id: input.sessionId,
		scope_id: input.scopeId,
		cwd: input.cwd,
		claim_command: claimCommand,
		claims: manifest.claims.join(", "),
		enqueues: manifest.enqueues.join(", "),
	});
	const env = {
		PITHOS_RUN_ID: input.runId,
		PITHOS_SESSION_ID: input.sessionId,
		PITHOS_SCOPE_ID: input.scopeId,
		PITHOS_BIN: config.pithosBin,
	};
	const argv =
		manifest.harness.kind === "claude"
			? ["claude", "--session-id", input.sessionId, "--system-prompt", prompt]
			: ["pi", "--session", sessionLogPath(input, "pi", config), "--system-prompt", prompt];
	return {
		...input,
		logicalName: logicalName(input),
		harness: { kind: manifest.harness.kind, argv, env },
		prompt,
	};
};

export const launchAgent = (
	input: RenderAgentInput,
	services: LaunchServices = LiveSpawnerServices,
): LaunchResult => {
	const config = loadConfig(services);
	const rendered = renderAgent(input, services);
	if (rendered.mode === "afk") {
		const child = services.spawnProcess(
			rendered.harness.argv[0] ?? "",
			rendered.harness.argv.slice(1),
			{
				cwd: rendered.cwd,
				env: rendered.harness.env,
			},
		);
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
			sessionLogPath: sessionLogPath(rendered, rendered.harness.kind as "claude" | "pi", config),
			afk: { pid: child.pid, processStartTime: new Date().toISOString() },
		};
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
		sessionLogPath: sessionLogPath(rendered, rendered.harness.kind as "claude" | "pi", config),
		hitl: { tmuxTarget: rendered.logicalName, panePid: pid },
	};
};
