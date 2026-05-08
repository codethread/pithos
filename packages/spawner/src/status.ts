import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { SpawnerError } from "./errors.ts";

type JsonRecord = Readonly<Record<string, unknown>>;
interface StatusMessage {
	readonly ts: string;
	readonly role: string;
	readonly text: string;
}

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const findFiles = (root: string, predicate: (name: string) => boolean): readonly string[] => {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) throw new Error("directory stack underflow");
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.isFile() && predicate(entry.name)) out.push(path);
		}
	}
	return out;
};

const claudeSessionsRoot = (): string =>
	process.env.PANDORA_SPAWN_CLAUDE_SESSIONS_ROOT ?? join(homedir(), ".claude", "projects");

const piSessionsRoot = (): string =>
	process.env.PANDORA_SPAWN_PI_SESSIONS_ROOT ?? join(homedir(), ".pi", "agent", "sessions");

const readJsonl = (path: string): readonly JsonRecord[] =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				const parsed = JSON.parse(line) as unknown;
				return isRecord(parsed) ? [parsed] : [];
			} catch {
				return [];
			}
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

const parseClaude = (path: string): readonly StatusMessage[] =>
	readJsonl(path).flatMap((entry) => {
		if (entry.type !== "user" && entry.type !== "assistant") return [];
		const message = entry.message;
		if (!isRecord(message)) return [];
		const text = textFromClaudeContent(message.content);
		if (text.length === 0) return [];
		return [{ ts: fmtTs(entry.timestamp), role: String(entry.type).toUpperCase(), text }];
	});

const parsePi = (path: string): readonly StatusMessage[] =>
	readJsonl(path).flatMap((entry) => {
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

const findClaudeSession = (sessionId: string): string | undefined =>
	findFiles(claudeSessionsRoot(), (name) => name === `${sessionId}.jsonl`)[0];

const findPiSessionByHeader = (sessionId: string): string | undefined =>
	findFiles(piSessionsRoot(), (name) => name.endsWith(".jsonl")).find((path) => {
		const [header] = readJsonl(path);
		return header?.type === "session" && header.id === sessionId;
	});

const findPiSession = (sessionId: string): string | undefined => {
	const filenameMatch = findFiles(piSessionsRoot(), (name) => name === `${sessionId}.jsonl`)[0];
	if (filenameMatch !== undefined) return filenameMatch;
	const suffixMatch = findFiles(piSessionsRoot(), (name) =>
		basename(name).endsWith(`_${sessionId}.jsonl`),
	)[0];
	if (suffixMatch !== undefined) return suffixMatch;
	return findPiSessionByHeader(sessionId);
};

const formatStatus = (messages: readonly StatusMessage[], lines: number): string =>
	messages
		.slice(-lines)
		.map((message) => {
			const oneLine = message.text.replace(/\s+/g, " ").trim();
			const snippet = oneLine.length > 400 ? oneLine.slice(0, 400) : oneLine;
			return `[${message.ts}] ${message.role}: ${snippet}`;
		})
		.join("\n");

export const renderStatus = (sessionId: string, lines: number): string => {
	const claudeFile = findClaudeSession(sessionId);
	if (claudeFile !== undefined) return formatStatus(parseClaude(claudeFile), lines);

	const piFile = findPiSession(sessionId);
	if (piFile !== undefined) return formatStatus(parsePi(piFile), lines);

	throw new SpawnerError({
		code: "NOT_FOUND",
		message: `session not found: ${sessionId}`,
	});
};
