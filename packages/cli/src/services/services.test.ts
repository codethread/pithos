import { describe, it, expect } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { ClockService } from "./clock.ts";
import { IdService } from "./ids.ts";
import { FsService } from "./fs.ts";
import { ProcessService } from "./process.ts";
import { DbService } from "./db.ts";
import { ClaudeHarnessService } from "./harness.ts";
import {
	ClockServiceLive,
	IdServiceLive,
	makeClockServiceTest,
	makeIdServiceTest,
	makeFsServiceTest,
	makeProcessServiceTest,
	makeDbServiceTest,
	makeClaudeHarnessServiceTest,
} from "../layers/index.ts";

/** Run an Effect with a provided layer, surfacing errors as rejected promises. */
function runWith<A, E, R>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R>): Promise<A> {
	return Effect.runPromise(Effect.provide(effect, layer));
}

// ---------------------------------------------------------------------------
// ClockService
// ---------------------------------------------------------------------------

describe("ClockService", () => {
	it("fake returns the fixed date", async () => {
		const fixed = new Date("2026-05-01T12:00:00.000Z");
		const result = await runWith(
			Effect.gen(function* () {
				const clock = yield* ClockService;
				return yield* clock.now;
			}),
			makeClockServiceTest(fixed),
		);
		expect(result).toEqual(fixed);
	});

	it("fake nowIso returns ISO string for fixed date", async () => {
		const fixed = new Date("2026-05-01T12:00:00.000Z");
		const result = await runWith(
			Effect.gen(function* () {
				const clock = yield* ClockService;
				return yield* clock.nowIso;
			}),
			makeClockServiceTest(fixed),
		);
		expect(result).toBe("2026-05-01T12:00:00.000Z");
	});

	it("live clock returns a Date", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const clock = yield* ClockService;
				return yield* clock.now;
			}),
			ClockServiceLive,
		);
		expect(result).toBeInstanceOf(Date);
	});
});

// ---------------------------------------------------------------------------
// IdService
// ---------------------------------------------------------------------------

describe("IdService", () => {
	it("fake returns predefined IDs in order", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const svc = yield* IdService;
				const a = yield* svc.generate("task");
				const b = yield* svc.generate("run");
				return { a, b };
			}),
			makeIdServiceTest(["task_001", "run_002"]),
		);
		expect(result.a).toBe("task_001");
		expect(result.b).toBe("run_002");
	});

	it("fake falls back to prefix_N when list is exhausted", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const svc = yield* IdService;
				const a = yield* svc.generate("task");
				const b = yield* svc.generate("task");
				return { a, b };
			}),
			makeIdServiceTest(["task_only"]),
		);
		expect(result.a).toBe("task_only");
		expect(result.b).toMatch(/^task_/);
	});

	it("live generates a prefixed ID", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const svc = yield* IdService;
				return yield* svc.generate("task");
			}),
			IdServiceLive,
		);
		expect(result).toMatch(/^task_[a-f0-9]{16}$/);
	});
});

// ---------------------------------------------------------------------------
// FsService
// ---------------------------------------------------------------------------

describe("FsService", () => {
	it("fake: write then read returns same content", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const fs = yield* FsService;
				yield* fs.writeFile("/tmp/hello.txt", "pithos");
				return yield* fs.readFile("/tmp/hello.txt");
			}),
			makeFsServiceTest(),
		);
		expect(result).toBe("pithos");
	});

	it("fake: exists returns false for unseen path", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const fs = yield* FsService;
				return yield* fs.exists("/nowhere/missing.txt");
			}),
			makeFsServiceTest(),
		);
		expect(result).toBe(false);
	});

	it("fake: exists returns true after write", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const fs = yield* FsService;
				yield* fs.writeFile("/tmp/exist.txt", "yes");
				return yield* fs.exists("/tmp/exist.txt");
			}),
			makeFsServiceTest(),
		);
		expect(result).toBe(true);
	});

	it("fake: mkdir marks directory as existing", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const fs = yield* FsService;
				yield* fs.mkdir("/tmp/newdir");
				return yield* fs.exists("/tmp/newdir");
			}),
			makeFsServiceTest(),
		);
		expect(result).toBe(true);
	});

	it("fake: readFile fails with NOT_FOUND for missing file", async () => {
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				Effect.gen(function* () {
					const fs = yield* FsService;
					return yield* fs.readFile("/missing.txt");
				}),
				makeFsServiceTest(),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fake: initial seed is readable", async () => {
		const seed = new Map([["/config/pithos.json", '{"version":1}']]);
		const result = await runWith(
			Effect.gen(function* () {
				const fs = yield* FsService;
				return yield* fs.readFile("/config/pithos.json");
			}),
			makeFsServiceTest(seed),
		);
		expect(result).toBe('{"version":1}');
	});
});

// ---------------------------------------------------------------------------
// ProcessService
// ---------------------------------------------------------------------------

describe("ProcessService", () => {
	it("fake returns configured stdout and exit code", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const proc = yield* ProcessService;
				return yield* proc.exec("echo", ["hello"]);
			}),
			makeProcessServiceTest([{ exitCode: 0, stdout: "hello\n", stderr: "" }]),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello\n");
	});

	it("fake sequences multiple responses", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const proc = yield* ProcessService;
				const r1 = yield* proc.exec("cmd1", []);
				const r2 = yield* proc.exec("cmd2", []);
				return [r1.exitCode, r2.exitCode] as const;
			}),
			makeProcessServiceTest([
				{ exitCode: 0, stdout: "first", stderr: "" },
				{ exitCode: 2, stdout: "", stderr: "oops" },
			]),
		);
		expect(result[0]).toBe(0);
		expect(result[1]).toBe(2);
	});

	it("fake falls back to exit 0 when responses exhausted", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const proc = yield* ProcessService;
				yield* proc.exec("cmd1", []);
				return yield* proc.exec("cmd2", []);
			}),
			makeProcessServiceTest([{ exitCode: 1, stdout: "", stderr: "first only" }]),
		);
		expect(result.exitCode).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// DbService (placeholder)
// ---------------------------------------------------------------------------

describe("DbService placeholder", () => {
	it("fake query returns seeded rows for matching SQL", async () => {
		const seeded = [{ id: "task_1", status: "queued" }];
		const result = await runWith(
			Effect.gen(function* () {
				const db = yield* DbService;
				return yield* db.query("SELECT * FROM tasks");
			}),
			makeDbServiceTest(new Map([["SELECT * FROM tasks", seeded]])),
		);
		expect(result).toEqual(seeded);
	});

	it("fake query returns empty array for unknown SQL", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const db = yield* DbService;
				return yield* db.query("SELECT 1");
			}),
			makeDbServiceTest(),
		);
		expect(result).toEqual([]);
	});

	it("fake run returns void", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const db = yield* DbService;
				return yield* db.run("INSERT INTO tasks VALUES (?)", ["task_1"]);
			}),
			makeDbServiceTest(),
		);
		// db.run returns void — just verify it succeeds
		expect(result).toBeUndefined();
	});

	it("fake withTransaction passes through the inner Effect result", async () => {
		const seeded = [{ id: "task_tx", status: "queued" }];
		const result = await runWith(
			Effect.gen(function* () {
				const db = yield* DbService;
				return yield* db.withTransaction(
					Effect.gen(function* () {
						const rows = yield* db.query("SELECT * FROM tasks");
						return rows.length;
					}),
				);
			}),
			makeDbServiceTest(new Map([["SELECT * FROM tasks", seeded]])),
		);
		expect(result).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// ClaudeHarnessService
// ---------------------------------------------------------------------------

describe("ClaudeHarnessService", () => {
	it("fake spawn returns configured session", async () => {
		const result = await runWith(
			Effect.gen(function* () {
				const harness = yield* ClaudeHarnessService;
				return yield* harness.spawn({ agent: "envy" });
			}),
			makeClaudeHarnessServiceTest({ sessionId: "session_abc", pid: 12345 }),
		);
		expect(result.sessionId).toBe("session_abc");
		expect(result.pid).toBe(12345);
	});
});

// ---------------------------------------------------------------------------
// DI composition: multiple fake services, no real system deps
// ---------------------------------------------------------------------------

describe("DI composition — commands testable without real system dependencies", () => {
	it("simulates a task-creation flow using clock + ids + fs fakes", async () => {
		const fixed = new Date("2026-05-01T12:00:00.000Z");

		const createTaskRecord = Effect.gen(function* () {
			const clock = yield* ClockService;
			const ids = yield* IdService;
			const fs = yield* FsService;

			const createdAt = yield* clock.nowIso;
			const id = yield* ids.generate("task");
			const filePath = `/tasks/${id}.json`;
			yield* fs.writeFile(filePath, JSON.stringify({ id, createdAt }));
			return yield* fs.readFile(filePath);
		});

		const layer = Layer.mergeAll(
			makeClockServiceTest(fixed),
			makeIdServiceTest(["task_demo001"]),
			makeFsServiceTest(),
		);

		const raw = await runWith(createTaskRecord, layer);
		const parsed: unknown = JSON.parse(raw) as unknown;
		expect(parsed).toMatchObject({
			id: "task_demo001",
			createdAt: "2026-05-01T12:00:00.000Z",
		});
	});

	it("simulates a claim dispatch using db + process fakes without real system calls", async () => {
		const seededTasks = [{ id: "task_1", status: "queued", capability: "watch" }];

		const dispatchFlow = Effect.gen(function* () {
			const db = yield* DbService;
			const proc = yield* ProcessService;

			const tasks = yield* db.query("SELECT * FROM tasks WHERE status = 'queued'");
			const first = tasks[0];
			if (first === undefined) return { claimed: false as const };

			const claimResult = yield* proc.exec("pithos", ["claim", "--run", "run_1"]);
			return {
				claimed: true as const,
				taskId: first.id,
				exitCode: claimResult.exitCode,
			};
		});

		const layer = Layer.mergeAll(
			makeDbServiceTest(new Map([["SELECT * FROM tasks WHERE status = 'queued'", seededTasks]])),
			makeProcessServiceTest([{ exitCode: 0, stdout: '{"ok":true}', stderr: "" }]),
		);

		const result = await runWith(dispatchFlow, layer);
		expect(result).toMatchObject({ claimed: true, taskId: "task_1", exitCode: 0 });
	});
});
