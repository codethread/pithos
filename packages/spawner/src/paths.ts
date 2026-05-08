import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageRootFromEnv = process.env.PANDORA_SPAWN_PACKAGE_ROOT

export const packageRoot = packageRootFromEnv ?? resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const templatesDir = resolve(packageRoot, "templates")
export const agentsPath = resolve(templatesDir, "agents.json")
export const piExtensionDir = resolve(packageRoot, "pi-extension")
