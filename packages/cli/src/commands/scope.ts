import { Effect } from "effect"
import { DbService } from "../services/db.ts"
import { OutputService } from "../services/output.ts"
import { PithosError } from "../errors/errors.ts"
import { canonicalizePath, deriveScopeId, nameFromPath } from "../domain/scope.ts"
import type { ScopeKind } from "../domain/scope.ts"
import { withCommandObservability } from "../layers/metrics.ts"

export interface ScopeUpsertOptions {
  readonly kind: ScopeKind
  readonly path: string | undefined
}

/**
 * `pithos scope upsert --kind <kind> --path <path>`
 *
 * Creates or updates a scope. For `repo`/`worktree` kinds, `--path` is
 * required and the scope ID is derived as `<kind>:<home-relative-path>`.
 * For `global`, no path is needed; the scope ID is always `"global"`.
 *
 * Idempotent: repeated calls with the same path produce the same scope ID
 * and update `updated_at` only.
 */
export const scopeUpsertCommand = (
  opts: ScopeUpsertOptions,
): Effect.Effect<void, PithosError, DbService | OutputService> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const output = yield* OutputService

    if (opts.kind === "global") {
      yield* db.run(
        `INSERT INTO scopes (id, kind, name, canonical_path, metadata_json, updated_at)
         VALUES ('global', 'global', 'global', NULL, '{}', CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
      )
      yield* output.print(
        JSON.stringify({ ok: true, scope: { id: "global", kind: "global", name: "global" } }),
      )
      return
    }

    // repo / worktree — path required
    if (!opts.path) {
      yield* Effect.fail(
        new PithosError({
          code: "VALIDATION_ERROR",
          message: `--path is required for kind '${opts.kind}'`,
        }),
      )
      return
    }

    const canonicalPath = canonicalizePath(opts.path)
    const id = deriveScopeId(opts.kind, canonicalPath)
    const name = nameFromPath(canonicalPath)

    yield* db.run(
      `INSERT INTO scopes (id, kind, name, canonical_path, metadata_json, updated_at)
       VALUES (?, ?, ?, ?, '{}', CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         kind           = excluded.kind,
         name           = excluded.name,
         canonical_path = excluded.canonical_path,
         updated_at     = CURRENT_TIMESTAMP`,
      [id, opts.kind, name, canonicalPath],
    )

    yield* output.print(
      JSON.stringify({
        ok: true,
        scope: { id, kind: opts.kind, name, canonical_path: canonicalPath },
      }),
    )
  }).pipe(
    Effect.withLogSpan("pithos.scope.upsert"),
    withCommandObservability("scope.upsert"),
  )

export const SCOPE_UPSERT_HELP = `pithos scope upsert - Register a scope (global/repo/worktree)

Usage:
  pithos scope upsert --path <path> [--kind <kind>]

Options:
  --path <path>   Filesystem path for the scope (required for repo/worktree)
  --kind <kind>   Scope kind: global | repo | worktree (default: repo)
  --help, -h      Show this help

Output (JSON):
  { "ok": true, "scope": { "id": "...", "kind": "...", "name": "...", "canonical_path": "..." } }

Examples:
  pithos scope upsert --path ~/work/perkbox-services/protobuf
  pithos scope upsert --kind worktree --path ~/work/perkbox-services/protobuf__feature
  pithos scope upsert --kind global

Notes:
  - Scope IDs are home-relative: ~/work/foo → repo:work/foo
  - Calling upsert twice with the same path is idempotent.

Exit codes: 0 success | 2 validation error
`
