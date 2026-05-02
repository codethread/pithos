import { Effect } from "effect"
import { DbService } from "../services/db.ts"
import { FsService } from "../services/fs.ts"
import { IdService } from "../services/ids.ts"
import { PithosError } from "../errors/errors.ts"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ArtifactAddOptions {
  readonly task: string | undefined
  readonly run: string | undefined
  readonly kind: string | undefined
  readonly title: string | undefined
  readonly bodyFile: string | undefined
}

// ---------------------------------------------------------------------------
// pithos artifact add
// ---------------------------------------------------------------------------

/**
 * `pithos artifact add --task <id> --run <id> --kind <kind> --title <title> [--body-file <path>]`
 *
 * Inserts a row into the artifacts table and prints the new artifact as JSON.
 * If `--body-file` is given, reads the file and stores its content in `body`.
 */
export const artifactAddCommand = (
  opts: ArtifactAddOptions,
): Effect.Effect<void, PithosError, DbService | IdService | FsService> =>
  Effect.gen(function* () {
    if (!opts.task) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--task is required" }),
      )
      return
    }
    if (!opts.run) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--run is required" }),
      )
      return
    }
    if (!opts.kind) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--kind is required" }),
      )
      return
    }
    if (!opts.title) {
      yield* Effect.fail(
        new PithosError({ code: "VALIDATION_ERROR", message: "--title is required" }),
      )
      return
    }

    // Read body from file if provided.
    const fs = yield* FsService
    let body = ""
    if (opts.bodyFile) {
      body = yield* fs.readFile(opts.bodyFile)
    }

    const ids = yield* IdService
    const artifactId = yield* ids.generate("artifact")

    const db = yield* DbService

    const artifact = yield* db.transaction((tx): Record<string, unknown> => {
      const rows = tx.query(
        `INSERT INTO artifacts (id, task_id, run_id, kind, title, body)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`,
        [artifactId, opts.task, opts.run, opts.kind, opts.title, body],
      )

      if (rows.length === 0) {
        // Should never happen — RETURNING * always returns the inserted row
        throw new Error("artifact insert returned no rows")
      }

      return rows[0]!
    })

    yield* Effect.sync(() => {
      console.log(JSON.stringify({ ok: true, artifact }))
    })
  })

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const ARTIFACT_ADD_HELP = `pithos artifact add - Attach an artifact to a task

Usage:
  pithos artifact add --task <task-id> --run <run-id> --kind <kind> --title <title> [options]

Options:
  --task <task-id>    Task to attach the artifact to [required]
  --run <run-id>      Run that is producing the artifact [required]
  --kind <kind>       Artifact kind, e.g. worker-completion, design-brief [required]
  --title <title>     Human-readable title for the artifact [required]
  --body-file <path>  Path to a file whose content becomes the artifact body
  --help, -h          Show this help

Output (JSON):
  { "ok": true, "artifact": { "id": "artifact_...", "kind": "...", "title": "...", ... } }

Examples:
  pithos artifact add --task task_abc --run run_xyz --kind worker-completion --title "Worker report" --body-file report.md
  pithos artifact add --task task_abc --run run_xyz --kind design-brief --title "Design notes"

Exit codes: 0 success | 2 validation error | 3 not found
`
