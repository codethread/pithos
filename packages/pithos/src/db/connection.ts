import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Resolves the effective SQLite DB path.
 * Prefers PITHOS_DB environment variable; falls back to ~/.pandora/pithos-next.sqlite.
 */
export const resolveDbPath = (): string => {
  const fromEnv = process.env.PITHOS_DB
  if (fromEnv) return fromEnv
  return join(homedir(), ".pandora", "pithos-next.sqlite")
}
