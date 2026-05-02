/**
 * Integration tests — metric counter increments from real command paths.
 *
 * Uses the command functions directly (not CLI subprocesses) with a real
 * temp SQLite DB so we can read Effect metric state in the same process.
 *
 * Reads delta (before → after) rather than absolute counts so tests are
 * order-independent even though Effect metrics are global within a process.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Layer, Metric } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { claimCommand } from "../src/commands/claim.ts"
import { heartbeatCommand } from "../src/commands/heartbeat.ts"
import { completeCommand } from "../src/commands/complete.ts"
import { failCommand } from "../src/commands/fail.ts"
import { enqueueCommand } from "../src/commands/enqueue.ts"
import { runRegisterCommand } from "../src/commands/run.ts"
import { initCommand } from "../src/commands/init.ts"
import { makeDbServiceLive } from "../src/layers/db.ts"
import { makeIdServiceTest } from "../src/layers/ids.ts"
import { FsServiceLive } from "../src/layers/fs.ts"
import { makeOutputServiceSilent } from "../src/layers/output.ts"
import {
  tasksClaimedCounter,
  heartbeatsWrittenCounter,
  heartbeatsThrottledCounter,
  staleTokensHeartbeatCounter,
  staleTokensCompleteCounter,
  staleTokensFailCounter,
} from "../src/layers/metrics.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentOutput = makeOutputServiceSilent()

/**
 * Read current count from a counter metric.
 * Metric.value returns Effect<Out> where Out = MetricState.Counter<number> at runtime ({count:N}).
 * We use a generic Over Out extends {count:number} to keep types sound without any.
 */
const readCount = <Type, In, Out extends { count: number }>(
  counter: Metric.Metric<Type, In, Out>,
): Effect.Effect<number> =>
  Metric.value(counter).pipe(Effect.map((s) => s.count))

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pithos-metrics-"))
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

describe("metrics integration", () => {
  let tempDir: string
  let dbLayer: ReturnType<typeof makeDbServiceLive>

  beforeEach(async () => {
    tempDir = makeTempDir()
    dbLayer = makeDbServiceLive(join(tempDir, "pithos.sqlite"))
    await Effect.runPromise(Effect.provide(initCommand, Layer.merge(dbLayer, silentOutput)))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const run = <A, E>(eff: Effect.Effect<A, E, never>) => Effect.runPromise(eff)

  const withAll = <A, E>(eff: Effect.Effect<A, E, never>) =>
    Effect.provide(eff, Layer.merge(dbLayer, silentOutput))

  const enqueueTask = (id: string, capability = "triage") =>
    run(
      Effect.provide(
        enqueueCommand({ scope: "global", capability, title: `Task ${id}` }),
        Layer.mergeAll(dbLayer, makeIdServiceTest([id]), FsServiceLive, silentOutput),
      ) as Effect.Effect<void, never, never>,
    )

  const registerRun = (id: string) =>
    run(
      Effect.provide(
        runRegisterCommand({ agentKind: "envy", run: id }),
        Layer.mergeAll(dbLayer, makeIdServiceTest([id]), FsServiceLive, silentOutput),
      ) as Effect.Effect<void, never, never>,
    )

  const claim = (runId: string) =>
    run(
      withAll(
        claimCommand({ run: runId, scope: "global", capability: "triage" }) as Effect.Effect<
          void,
          never,
          never
        >,
      ),
    )

  // ---------------------------------------------------------------------------
  // tasksClaimedCounter
  // ---------------------------------------------------------------------------

  describe("tasksClaimedCounter", () => {
    it("increments by 1 on a successful claim", async () => {
      await enqueueTask("task_mc1")
      await registerRun("run_mc1")

      const [before, after] = await run(
        Effect.gen(function* () {
          const before = yield* readCount(tasksClaimedCounter)
          yield* claimCommand({ run: "run_mc1", scope: "global", capability: "triage" })
          const after = yield* readCount(tasksClaimedCounter)
          return [before, after] as const
        }).pipe(Effect.provide(Layer.merge(dbLayer, silentOutput))) as Effect.Effect<
          readonly [number, number],
          never,
          never
        >,
      )

      expect(after - before).toBe(1)
    })

    it("does NOT increment when no tasks are available", async () => {
      await registerRun("run_mc_nowork")

      const [before, after] = await run(
        Effect.gen(function* () {
          const before = yield* readCount(tasksClaimedCounter)
          yield* claimCommand({
            run: "run_mc_nowork",
            scope: "global",
            capability: "triage",
          }).pipe(Effect.orElse(() => Effect.void))
          const after = yield* readCount(tasksClaimedCounter)
          return [before, after] as const
        }).pipe(Effect.provide(Layer.merge(dbLayer, silentOutput))) as Effect.Effect<
          readonly [number, number],
          never,
          never
        >,
      )

      expect(after - before).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // heartbeat counters
  // ---------------------------------------------------------------------------

  describe("heartbeat counters", () => {
    it("heartbeatsWrittenCounter increments on a non-throttled heartbeat", async () => {
      await registerRun("run_hb1")

      const [before, after] = await run(
        Effect.gen(function* () {
          const before = yield* readCount(heartbeatsWrittenCounter)
          yield* heartbeatCommand({ run: "run_hb1" })
          const after = yield* readCount(heartbeatsWrittenCounter)
          return [before, after] as const
        }).pipe(Effect.provide(Layer.merge(dbLayer, silentOutput))) as Effect.Effect<
          readonly [number, number],
          never,
          never
        >,
      )

      expect(after - before).toBe(1)
    })

    it("heartbeatsThrottledCounter increments when within throttle window", async () => {
      await registerRun("run_hbt1")
      // First heartbeat establishes last_heartbeat_at
      await run(
        Effect.provide(
          heartbeatCommand({ run: "run_hbt1" }),
          Layer.merge(dbLayer, silentOutput),
        ) as Effect.Effect<void, never, never>,
      )

      const [before, after] = await run(
        Effect.gen(function* () {
          const before = yield* readCount(heartbeatsThrottledCounter)
          // Second heartbeat within 60s throttle window → should be skipped
          yield* heartbeatCommand({ run: "run_hbt1", throttleSeconds: 60 })
          const after = yield* readCount(heartbeatsThrottledCounter)
          return [before, after] as const
        }).pipe(Effect.provide(Layer.merge(dbLayer, silentOutput))) as Effect.Effect<
          readonly [number, number],
          never,
          never
        >,
      )

      expect(after - before).toBe(1)
    })

    it("heartbeatsWrittenCounter does NOT increment when throttled", async () => {
      await registerRun("run_hb_nothrottle")
      await run(
        Effect.provide(
          heartbeatCommand({ run: "run_hb_nothrottle" }),
          Layer.merge(dbLayer, silentOutput),
        ) as Effect.Effect<void, never, never>,
      )

      const [before, after] = await run(
        Effect.gen(function* () {
          const before = yield* readCount(heartbeatsWrittenCounter)
          yield* heartbeatCommand({ run: "run_hb_nothrottle", throttleSeconds: 60 })
          const after = yield* readCount(heartbeatsWrittenCounter)
          return [before, after] as const
        }).pipe(Effect.provide(Layer.merge(dbLayer, silentOutput))) as Effect.Effect<
          readonly [number, number],
          never,
          never
        >,
      )

      expect(after - before).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // staleToken counters
  // ---------------------------------------------------------------------------

  describe("stale token counters", () => {
    it("staleTokensHeartbeatCounter increments on stale heartbeat token", async () => {
      await enqueueTask("task_hb_stale")
      await registerRun("run_hb_stale")
      await claim("run_hb_stale")

      const [before, after] = await run(
        Effect.gen(function* () {
          const before = yield* readCount(staleTokensHeartbeatCounter)
          yield* heartbeatCommand({
            run: "run_hb_stale",
            task: "task_hb_stale",
            token: 999, // wrong token
          }).pipe(Effect.orElse(() => Effect.void))
          const after = yield* readCount(staleTokensHeartbeatCounter)
          return [before, after] as const
        }).pipe(Effect.provide(Layer.merge(dbLayer, silentOutput))) as Effect.Effect<
          readonly [number, number],
          never,
          never
        >,
      )

      expect(after - before).toBe(1)
    })

    it("staleTokensCompleteCounter increments on stale complete token", async () => {
      await enqueueTask("task_cmp_stale")
      await registerRun("run_cmp_stale")
      await claim("run_cmp_stale")

      const [before, after] = await run(
        Effect.gen(function* () {
          const before = yield* readCount(staleTokensCompleteCounter)
          yield* completeCommand({
            taskId: "task_cmp_stale",
            run: "run_cmp_stale",
            token: 999, // wrong token
          }).pipe(
            Effect.provide(FsServiceLive),
            Effect.orElse(() => Effect.void),
          )
          const after = yield* readCount(staleTokensCompleteCounter)
          return [before, after] as const
        }).pipe(Effect.provide(Layer.merge(dbLayer, silentOutput))) as Effect.Effect<
          readonly [number, number],
          never,
          never
        >,
      )

      expect(after - before).toBe(1)
    })

    it("staleTokensFailCounter increments on stale fail token", async () => {
      await enqueueTask("task_fail_stale")
      await registerRun("run_fail_stale")
      await claim("run_fail_stale")

      const [before, after] = await run(
        Effect.gen(function* () {
          const before = yield* readCount(staleTokensFailCounter)
          yield* failCommand({
            taskId: "task_fail_stale",
            run: "run_fail_stale",
            token: 999, // wrong token
          }).pipe(Effect.orElse(() => Effect.void))
          const after = yield* readCount(staleTokensFailCounter)
          return [before, after] as const
        }).pipe(Effect.provide(Layer.merge(dbLayer, silentOutput))) as Effect.Effect<
          readonly [number, number],
          never,
          never
        >,
      )

      expect(after - before).toBe(1)
    })
  })
})
