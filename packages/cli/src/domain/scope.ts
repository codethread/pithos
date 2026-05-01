import { homedir } from "node:os"
import { resolve, relative, isAbsolute, basename } from "node:path"

/**
 * Pure domain helpers for scope ID derivation and path canonicalisation.
 *
 * Scope IDs are home-relative addresses, e.g.:
 *   ~/work/perkbox-services/protobuf  →  repo:work/perkbox-services/protobuf
 *
 * If a path is outside $HOME, the absolute path (without leading '/') is used
 * so IDs remain stable and unambiguous.
 */

export type ScopeKind = "global" | "repo" | "worktree"

/**
 * Expand `~` and resolve relative paths to an absolute path.
 * Does not touch the filesystem; only string manipulation + `path.resolve`.
 */
export const canonicalizePath = (rawPath: string): string => {
  const withHome =
    rawPath === "~"
      ? homedir()
      : rawPath.startsWith("~/")
        ? homedir() + rawPath.slice(1)
        : rawPath
  return isAbsolute(withHome) ? withHome : resolve(withHome)
}

/**
 * Derive a stable, home-relative scope ID from a kind and an absolute path.
 *
 * @example
 *   deriveScopeId("repo", "/Users/adam/work/perkbox/protobuf")
 *   // → "repo:work/perkbox/protobuf"  (when $HOME is /Users/adam)
 */
export const deriveScopeId = (kind: "repo" | "worktree", absolutePath: string): string => {
  const home = homedir()
  const rel = relative(home, absolutePath)
  // If path escapes $HOME the relative path starts with ".."; use the trimmed
  // absolute path as fallback so the ID is still meaningful.
  const segment = rel.startsWith("..") ? absolutePath.replace(/^\//, "") : rel
  return `${kind}:${segment}`
}

/**
 * Extract a human-readable display name from a path (the final path component).
 */
export const nameFromPath = (absolutePath: string): string => basename(absolutePath)
