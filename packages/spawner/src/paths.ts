import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, ".."), resolve(here, "../../spawner")];
export const packageRoot = candidates.find((root) =>
	existsSync(resolve(root, "templates/agents.json")),
);
if (packageRoot === undefined) {
	throw new Error(`spawner templates not found from ${here}`);
}
export const templatesDir = resolve(packageRoot, "templates");
export const agentsPath = resolve(templatesDir, "agents.json");
export const piExtensionDir = resolve(packageRoot, "pi-extension");
