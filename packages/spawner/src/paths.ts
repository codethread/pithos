import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
if (!existsSync(resolve(repoRoot, "templates/agents.json"))) {
	throw new Error(`repo templates not found from ${here}`);
}

export const bundledTemplatesDir = resolve(repoRoot, "templates");
export const resolveTemplatesDir = (pdxDataDir: string | undefined): string =>
	pdxDataDir === undefined ? bundledTemplatesDir : resolve(pdxDataDir, "templates");
export const resolveAgentsPath = (pdxDataDir: string | undefined): string =>
	resolve(resolveTemplatesDir(pdxDataDir), "agents.json");
export const resolveExtensionsTemplatesDir = (pdxDataDir: string | undefined): string | undefined =>
	pdxDataDir === undefined ? undefined : resolve(pdxDataDir, "extensions", "templates");
