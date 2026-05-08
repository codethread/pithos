import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_CONTRACT,
	PithosError,
	RunRowSchema,
	decodeRow,
	loadConfig,
	runCli,
	type Services,
} from "../src/index.js";

const tempDb = () => join(mkdtempSync(join(tmpdir(), "pithos-next-")), "pithos.db");

const services = (): Services & { stdout: string[]; stderr: string[] } => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		fs: { readText: () => "body", removeFile: (path) => rmSync(path, { force: true }) },
		output: { write: (text) => stdout.push(text), writeError: (text) => stderr.push(text) },
		ids: { make: (prefix) => `${prefix}_test_${stdout.length}_${stderr.length}` },
		clock: { nowIso: () => "2026-05-08T00:00:00.000Z" },
	};
};

const init = (dbPath: string, fresh = false) => {
	const svc = services();
	const code = runCli({ config: { dbPath }, services: svc }, [
		"init",
		...(fresh ? ["--fresh"] : []),
	]);
	expect(code).toBe(0);
	return new Database(dbPath);
};

describe("pithos foundation", () => {
	it("fresh init creates schema, seeds, and partial run task index", () => {
		const db = init(tempDb(), true);
		expect(db.prepare("SELECT id FROM scopes").pluck().all()).toEqual(["global"]);
		expect(
			db.prepare("SELECT agent_kind FROM agent_kinds ORDER BY agent_kind").pluck().all(),
		).toEqual([...BUILTIN_CONTRACT.agentKinds].sort());
		expect(
			db.prepare("SELECT capability FROM capabilities ORDER BY capability").pluck().all(),
		).toEqual([...BUILTIN_CONTRACT.capabilities].sort());
		expect(
			db
				.prepare("SELECT agent_kind || ':' || capability FROM agent_claims ORDER BY 1")
				.pluck()
				.all(),
		).toEqual(["greed:design", "pandora:escalate", "toil:triage", "war:execute"]);
		expect(
			db
				.prepare("SELECT agent_kind || ':' || capability FROM agent_enqueues ORDER BY 1")
				.pluck()
				.all(),
		).toEqual([
			"greed:design",
			"greed:escalate",
			"greed:triage",
			"pandora:design",
			"pandora:escalate",
			"pandora:triage",
			"pdx:escalate",
			"toil:design",
			"toil:escalate",
			"toil:execute",
			"toil:triage",
			"war:escalate",
		]);
		expect(
			db
				.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_runs_task_id'")
				.pluck()
				.get(),
		).toContain("WHERE task_id IS NOT NULL");
	});

	it("non-fresh init is idempotent", () => {
		const dbPath = tempDb();
		init(dbPath, true).close();
		init(dbPath).close();
		const db = new Database(dbPath);
		expect(db.prepare("SELECT COUNT(*) FROM agent_kinds").pluck().get()).toBe(5);
		expect(db.prepare("SELECT COUNT(*) FROM agent_enqueues").pluck().get()).toBe(12);
	});

	it("exported built-in contract matches seeded rows", () => {
		const db = init(tempDb(), true);
		const seeded = db
			.prepare("SELECT agent_kind, capability FROM agent_enqueues ORDER BY 1,2")
			.all();
		const contract = Object.entries(BUILTIN_CONTRACT.enqueues)
			.flatMap(([agent_kind, caps]) => caps.map((capability) => ({ agent_kind, capability })))
			.sort((a, b) =>
				`${a.agent_kind}:${a.capability}`.localeCompare(`${b.agent_kind}:${b.capability}`),
			);
		expect(seeded).toEqual(contract);
	});

	it("empty claims use the no-work contract", () => {
		const dbPath = tempDb();
		init(dbPath, true).close();
		const svc = services();
		expect(
			runCli({ config: { dbPath }, services: svc }, [
				"run",
				"upsert",
				"_",
				"--agent",
				"toil",
				"--mode",
				"afk",
				"--scope",
				"global",
				"--cwd",
				"/tmp",
				"--session-id",
				"session",
				"--run",
				"run_toil",
			]),
		).toBe(0);
		expect(
			runCli({ config: { dbPath }, services: svc }, [
				"task",
				"claim",
				"_",
				"--run",
				"run_toil",
				"--scope",
				"global",
				"--capability",
				"triage",
			]),
		).toBe(5);
		expect(svc.stderr.at(-1)).toContain('"code":"NO_CLAIMABLE_WORK"');
	});

	it("row decoders and config decoding fail loudly", () => {
		expect(() => decodeRow(RunRowSchema, { id: "run_bad" }, "bad run")).toThrow(PithosError);
		expect(() => loadConfig({ get: () => undefined })).toThrow(PithosError);
	});
});
