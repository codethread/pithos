import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ScopeKind = "global" | "repo" | "worktree";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
if (!existsSync(resolve(repoRoot, "templates/agents.toml"))) {
	throw new Error(`repo templates not found from ${here}`);
}

export const bundledTemplatesDir = resolve(repoRoot, "templates");
export const bundledAgentsPath = resolve(repoRoot, "templates", "agents.toml");

export const resolveUserDataDir = (
	pdxDataDir: string | undefined,
	pdxUserDataDir: string | undefined,
): string | undefined =>
	pdxUserDataDir ?? (pdxDataDir === undefined ? undefined : resolve(pdxDataDir, "config"));

export const resolveTemplatesDir = (pdxDataDir: string | undefined): string =>
	pdxDataDir === undefined ? bundledTemplatesDir : resolve(pdxDataDir, "templates");

export const resolveAgentsPath = (pdxDataDir: string | undefined): string =>
	pdxDataDir === undefined ? bundledAgentsPath : resolve(pdxDataDir, "agents.toml");
