import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface SpawnedProcess {
	readonly pid?: number;
}

export interface CommandResult {
	readonly status: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

export interface RenderServices {
	readonly readText: (path: string) => string;
	readonly env: (key: string) => string | undefined;
}

export interface LaunchServices extends RenderServices {
	readonly spawnProcess: (
		file: string,
		args: readonly string[],
		options: { readonly cwd: string; readonly env: Record<string, string> },
	) => SpawnedProcess;
	readonly execFile: (file: string, args: readonly string[]) => CommandResult;
}

export const LiveSpawnerServices: LaunchServices = {
	readText: (path) => readFileSync(path, "utf8"),
	env: (key) => process.env[key],
	spawnProcess: (file, args, options) => {
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: "ignore",
			detached: false,
		});
		return child.pid === undefined ? {} : { pid: child.pid };
	},
	execFile: (file, args) => spawnSync(file, args, { encoding: "utf8" }),
};
