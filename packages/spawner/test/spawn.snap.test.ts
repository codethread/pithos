import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expect, test } from "vitest";

test("envy spawn renders deterministic prompt + argv (fake harness)", () => {
	execFileSync("pnpm", ["run", "build"], { stdio: "ignore" });
	const db = join(mkdtempSync(join(tmpdir(), "pandora-spawn-")), "pithos.sqlite");
	const env = { ...process.env, PITHOS_DB: db, PANDORA_SPAWN_FAKE_SESSION_ID: "session-TEST" };
	execFileSync("pithos", ["init"], { env, stdio: "ignore" });
	execFileSync(
		"pithos",
		["scope", "upsert", "--kind", "repo", "--path", join(homedir(), "work", "example")],
		{ env, stdio: "ignore" },
	);
	const out = execFileSync(
		"pandora-spawn",
		[
			"--agent",
			"envy",
			"--scope",
			"repo:work/example",
			"--cwd",
			"/tmp/example",
			"--harness",
			"fake",
		],
		{ env },
	).toString();
	const parsed = JSON.parse(out) as Record<string, unknown>;
	const runId = parsed.run_id;
	if (typeof runId !== "string") throw new Error("missing run_id");
	const text = JSON.stringify(parsed).replaceAll(runId, "run_SNAPSHOT");
	expect(JSON.parse(text)).toMatchSnapshot();
}, 30_000);

test("preview pi harness renders pi argv + extension wiring", () => {
	execFileSync("pnpm", ["run", "build"], { stdio: "ignore" });
	const env = { ...process.env, PANDORA_SPAWN_FAKE_PITHOS_HELP: "pithos help" };
	const out = execFileSync(
		"pandora-spawn",
		["--agent", "pandora", "--scope", "repo:work/example", "--cwd", "/tmp/example", "--preview"],
		{ env },
	).toString();
	const parsed = JSON.parse(out) as { harness: string; argv: string[]; session_file?: string };
	expect(parsed.harness).toBe("pi");
	expect(parsed.argv[0]).toBe("pi");
	expect(parsed.argv).toContain("--extension");
	expect(parsed.argv).toContain("--session");
	expect(parsed.argv).toContain("--tools");
	expect(parsed.argv).toContain("bash,read,edit,write,grep,find,ls");
	expect(parsed.session_file).toBeTypeOf("string");
	expect(isAbsolute(parsed.session_file!)).toBe(true);
	expect(parsed.argv).toContain(parsed.session_file!);
	expect(parsed.argv.some((arg) => arg.endsWith("packages/spawner/pi-extension"))).toBe(true);
	expect(parsed.argv.at(-1)).toBe("begin");
}, 30_000);

test("preview greed renders design prompt + default kickoff", () => {
	execFileSync("pnpm", ["run", "build"], { stdio: "ignore" });
	const env = { ...process.env, PANDORA_SPAWN_FAKE_PITHOS_HELP: "pithos help" };
	const out = execFileSync(
		"pandora-spawn",
		["--agent", "greed", "--scope", "repo:work/example", "--cwd", "/tmp/example", "--preview"],
		{ env },
	).toString();
	const parsed = JSON.parse(out) as { harness: string; argv: string[] };
	expect(parsed.harness).toBe("pi");
	expect(parsed.argv.at(-1)).toBe("begin");
	expect(parsed.argv).toContain("--system-prompt");
	expect(
		parsed.argv.some((arg) => arg.includes("Claim one Pithos task with capability `design`")),
	).toBe(true);
	expect(
		parsed.argv.some((arg) =>
			arg.includes("Interview me relentlessly about every aspect of this plan"),
		),
	).toBe(true);
}, 30_000);
