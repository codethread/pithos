import { describe, expect, it } from "vitest"
import { Effect, Either, Layer } from "effect"
import { runCleanupCommand, runInterruptCommand, runUpsertCommand } from "./run.ts"
import { DbService } from "../services/db.ts"
import { IdService } from "../services/ids.ts"
import type { DbRow } from "../services/db.ts"
import { makeOutputServiceTest } from "../layers/output.ts"

interface FakeDb {
  readonly query: (sql: string, params?: readonly unknown[]) => Effect.Effect<readonly DbRow[], never>
  readonly run: (sql: string, params?: readonly unknown[]) => Effect.Effect<void, never>
  readonly withTransaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
}

const makeDbLayer = (db: FakeDb) =>
  Layer.succeed(DbService, {
    query: db.query,
    run: db.run,
    withTransaction: db.withTransaction,
  })

const idsLayer = Layer.succeed(IdService, {
  generate: () => Effect.succeed("run_generated"),
})

describe("run lifecycle commands", () => {
  it("reopens the terminal pdx system run with a refreshed cwd", async () => {
    const output = makeOutputServiceTest()
    let reopenParams: readonly unknown[] | undefined

    const db = makeDbLayer({
      query: (sql, params) => {
        if (sql === `SELECT * FROM scopes WHERE id = ?`) {
          return Effect.succeed([{ id: "global", kind: "global", name: "global", canonical_path: null, metadata_json: "{}", created_at: "2026-05-08T00:00:00Z", updated_at: "2026-05-08T00:00:00Z" }])
        }

        if (sql === `SELECT * FROM runs WHERE id = ?`) {
          return Effect.succeed([
            {
              id: "run_pdx_system",
              agent_kind: "pdx",
              mode: "afk",
              scope_id: "global",
              task_id: null,
              harness: "claude-code",
              session_id: "session_pdx_daemon",
              tmux_target: null,
              cwd: "/tmp/old-home",
              status: "ended",
              last_heartbeat_at: null,
              metadata_json: "{}",
              created_at: "2026-05-08T00:00:00Z",
              updated_at: "2026-05-08T00:00:00Z",
              ended_at: "2026-05-08T00:01:00Z",
            },
          ])
        }

        if (sql.includes("UPDATE runs") && sql.includes("cwd = ?") && sql.includes("session_id = ?")) {
          reopenParams = params
          return Effect.succeed([
            {
              id: "run_pdx_system",
              agent_kind: "pdx",
              mode: "afk",
              scope_id: "global",
              task_id: null,
              harness: "claude-code",
              session_id: "session_pdx_daemon",
              tmux_target: null,
              cwd: "/tmp/new-home",
              status: "starting",
              last_heartbeat_at: null,
              metadata_json: "{}",
              created_at: "2026-05-08T00:00:00Z",
              updated_at: "2026-05-08T00:02:00Z",
              ended_at: null,
            },
          ])
        }

        throw new Error(`unexpected query: ${sql}`)
      },
      run: () => Effect.void,
      withTransaction: (effect) => effect,
    })

    await Effect.runPromise(
      runUpsertCommand({
        agent: "pdx",
        mode: "afk",
        scope: "global",
        cwd: "/tmp/new-home",
        sessionId: "session_pdx_daemon",
        run: "run_pdx_system",
      }).pipe(
        Effect.provide(Layer.mergeAll(output.layer, db, idsLayer)),
      ),
    )

    expect(reopenParams).toEqual(["/tmp/new-home", "session_pdx_daemon", "run_pdx_system"])
    expect(JSON.parse(output.lines()[0]!)).toMatchObject({
      ok: true,
      run: { id: "run_pdx_system", status: "starting", scope_id: "global" },
    })
  })
  it("fails loudly with STALE_TOKEN_RACE when cleanup loses the fenced task update", async () => {
    const output = makeOutputServiceTest()
    const db = makeDbLayer({
      query: (sql) => {
        if (sql === `SELECT * FROM runs WHERE id = ?`) {
          return Effect.succeed([
            {
              id: "run_1",
              agent_kind: "toil",
              mode: "afk",
              scope_id: "global",
              task_id: "task_1",
              harness: "claude-code",
              session_id: "session_1",
              tmux_target: null,
              cwd: "/tmp",
              status: "running",
              last_heartbeat_at: null,
              metadata_json: "{}",
              created_at: "2026-05-08T00:00:00Z",
              updated_at: "2026-05-08T00:00:00Z",
              ended_at: null,
            },
          ])
        }

        if (sql === `SELECT * FROM tasks WHERE id = ?`) {
          return Effect.succeed([
            {
              id: "task_1",
              scope_id: "global",
              capability: "triage",
              status: "running",
              title: "task",
              body: "body",
              payload_json: "{}",
              fencing_token: 7,
              attempts: 1,
              max_attempts: 3,
              result_json: "{}",
              created_by_run_id: "run_seed",
              created_at: "2026-05-08T00:00:00Z",
              updated_at: "2026-05-08T00:00:00Z",
              completed_at: null,
            },
          ])
        }

        if (sql.includes("UPDATE tasks\n       SET\n         status = ?")) {
          return Effect.succeed([])
        }

        throw new Error(`unexpected query: ${sql}`)
      },
      run: () => Effect.void,
      withTransaction: (effect) => effect,
    })

    const result = await Effect.runPromise(
      runCleanupCommand({ run: "run_1", reason: "daemon_start" }).pipe(
        Effect.provide(Layer.merge(output.layer, db)),
        Effect.either,
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    expect(result).toMatchObject({ _tag: "Left", left: { code: "STALE_TOKEN_RACE" } })
  })

  it("settles a terminal held task during cleanup by ending the run and clearing task ownership", async () => {
    const output = makeOutputServiceTest()
    const runEventPayloads: string[] = []

    const db = makeDbLayer({
      query: (sql, params) => {
        if (sql === `SELECT * FROM runs WHERE id = ?`) {
          return Effect.succeed([
            {
              id: "run_done",
              agent_kind: "toil",
              mode: "afk",
              scope_id: "global",
              task_id: "task_done",
              harness: "claude-code",
              session_id: "session_done",
              tmux_target: null,
              cwd: "/tmp",
              status: "running",
              last_heartbeat_at: null,
              metadata_json: "{}",
              created_at: "2026-05-08T00:00:00Z",
              updated_at: "2026-05-08T00:00:00Z",
              ended_at: null,
            },
          ])
        }

        if (sql === `SELECT * FROM tasks WHERE id = ?`) {
          return Effect.succeed([
            {
              id: "task_done",
              scope_id: "global",
              capability: "triage",
              status: "done",
              title: "task",
              body: "body",
              payload_json: "{}",
              fencing_token: 1,
              attempts: 1,
              max_attempts: 3,
              result_json: "{}",
              created_by_run_id: "run_seed",
              created_at: "2026-05-08T00:00:00Z",
              updated_at: "2026-05-08T00:00:00Z",
              completed_at: "2026-05-08T00:01:00Z",
            },
          ])
        }

        if (sql.includes("UPDATE runs\n       SET\n         status = ?")) {
          return Effect.succeed([
            {
              id: "run_done",
              agent_kind: "toil",
              mode: "afk",
              scope_id: "global",
              task_id: null,
              harness: "claude-code",
              session_id: "session_done",
              tmux_target: null,
              cwd: "/tmp",
              status: params?.[0],
              last_heartbeat_at: null,
              metadata_json: "{}",
              created_at: "2026-05-08T00:00:00Z",
              updated_at: "2026-05-08T00:02:00Z",
              ended_at: "2026-05-08T00:02:00Z",
            },
          ])
        }

        throw new Error(`unexpected query: ${sql}`)
      },
      run: (sql, params) => {
        if (sql.includes("INSERT INTO events (run_id, type, payload_json)")) {
          const payload = params?.[2]
          runEventPayloads.push(typeof payload === "string" ? payload : "")
          return Effect.void
        }
        throw new Error(`unexpected run: ${sql}`)
      },
      withTransaction: (effect) => effect,
    })

    await Effect.runPromise(
      runCleanupCommand({ run: "run_done", reason: "natural exit" }).pipe(
        Effect.provide(Layer.merge(output.layer, db)),
      ),
    )

    expect(JSON.parse(output.lines()[0]!)).toMatchObject({
      ok: true,
      run: { id: "run_done", status: "ended", task_id: null },
    })
    expect(JSON.parse(runEventPayloads[0]!)).toMatchObject({
      reason: "natural exit",
      previous_status: "running",
      status: "ended",
      task_id: "task_done",
    })
  })

  it("settles a terminal held task during interrupt by failing the run and clearing task ownership", async () => {
    const output = makeOutputServiceTest()

    const db = makeDbLayer({
      query: (sql, params) => {
        if (sql === `SELECT * FROM runs WHERE id = ?`) {
          return Effect.succeed([
            {
              id: "run_failed",
              agent_kind: "toil",
              mode: "afk",
              scope_id: "global",
              task_id: "task_failed",
              harness: "claude-code",
              session_id: "session_failed",
              tmux_target: null,
              cwd: "/tmp",
              status: "running",
              last_heartbeat_at: null,
              metadata_json: "{}",
              created_at: "2026-05-08T00:00:00Z",
              updated_at: "2026-05-08T00:00:00Z",
              ended_at: null,
            },
          ])
        }

        if (sql === `SELECT * FROM tasks WHERE id = ?`) {
          return Effect.succeed([
            {
              id: "task_failed",
              scope_id: "global",
              capability: "triage",
              status: "failed",
              title: "task",
              body: "body",
              payload_json: "{}",
              fencing_token: 1,
              attempts: 1,
              max_attempts: 3,
              result_json: "{}",
              created_by_run_id: "run_seed",
              created_at: "2026-05-08T00:00:00Z",
              updated_at: "2026-05-08T00:00:00Z",
              completed_at: null,
            },
          ])
        }

        if (sql.includes("UPDATE runs\n       SET\n         status = ?")) {
          return Effect.succeed([
            {
              id: "run_failed",
              agent_kind: "toil",
              mode: "afk",
              scope_id: "global",
              task_id: null,
              harness: "claude-code",
              session_id: "session_failed",
              tmux_target: null,
              cwd: "/tmp",
              status: params?.[0],
              last_heartbeat_at: null,
              metadata_json: "{}",
              created_at: "2026-05-08T00:00:00Z",
              updated_at: "2026-05-08T00:02:00Z",
              ended_at: "2026-05-08T00:02:00Z",
            },
          ])
        }

        throw new Error(`unexpected query: ${sql}`)
      },
      run: () => Effect.void,
      withTransaction: (effect) => effect,
    })

    await Effect.runPromise(
      runInterruptCommand({ run: "run_failed", reason: "operator kill" }).pipe(
        Effect.provide(Layer.merge(output.layer, db)),
      ),
    )

    expect(JSON.parse(output.lines()[0]!)).toMatchObject({
      ok: true,
      run: { id: "run_failed", status: "failed", task_id: null },
    })
  })
})
