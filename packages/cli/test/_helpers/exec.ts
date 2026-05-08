import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

// Async subprocess invocation. Sync variants (execFileSync/spawnSync) block the
// vitest worker event loop, which trips the RPC ping window and bleeds child
// stderr into the dot reporter. Async keeps the loop ticking and captures
// stderr cleanly regardless of exit code.
export async function runCli(
	bin: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<CliResult> {
	try {
		const { stdout, stderr } = await execFileP(bin, args, { env, encoding: "utf-8" });
		return { stdout, stderr, exitCode: 0 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; code?: number | string };
		return {
			stdout: typeof e.stdout === "string" ? e.stdout : "",
			stderr: typeof e.stderr === "string" ? e.stderr : "",
			exitCode: typeof e.code === "number" ? e.code : 1,
		};
	}
}

// Convenience: throws if exit != 0. Use for setup steps where failure is fatal
// to the test (e.g. seeding via `pithos init`).
export async function runCliOk(
	bin: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<string> {
	const result = await runCli(bin, args, env);
	if (result.exitCode !== 0) {
		throw new Error(
			`${bin} ${args.join(" ")} exited ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
	}
	return result.stdout;
}
