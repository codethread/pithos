import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ScopeKind = "global" | "repo" | "worktree";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
export const bundledDataDirResourcesDir = resolve(repoRoot, "resources", "data-dir");
export const bundledUserDataDirResourcesDir = resolve(repoRoot, "resources", "user-data-dir");

if (!existsSync(resolve(bundledDataDirResourcesDir, "agents.toml"))) {
	throw new Error(`repo resources not found from ${here}`);
}

export const bundledTemplatesDir = resolve(bundledDataDirResourcesDir, "templates");
export const bundledAgentsPath = resolve(bundledDataDirResourcesDir, "agents.toml");

export const resolveUserDataDir = (
	pdxDataDir: string | undefined,
	pdxUserDataDir: string | undefined,
): string | undefined =>
	pdxUserDataDir ?? (pdxDataDir === undefined ? undefined : resolve(pdxDataDir, "config"));

export const resolveTemplatesDir = (pdxDataDir: string | undefined): string =>
	pdxDataDir === undefined ? bundledTemplatesDir : resolve(pdxDataDir, "templates");

export const resolveAgentsPath = (pdxDataDir: string | undefined): string =>
	pdxDataDir === undefined ? bundledAgentsPath : resolve(pdxDataDir, "agents.toml");
