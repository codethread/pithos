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
	readonly execFile: (file: string, args: readonly string[]) => CommandResult;
}

export interface LaunchServices extends RenderServices {
	readonly spawnProcess: (
		file: string,
		args: readonly string[],
		options: { readonly cwd: string; readonly env: Record<string, string> },
	) => SpawnedProcess;
}

export interface FakeSpawnerServicesInput {
	readonly files: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
	readonly env?: Readonly<Record<string, string>>;
	readonly spawnPid?: number;
	readonly commandResult?: CommandResult;
}

const isReadonlyMap = (
	files: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): files is ReadonlyMap<string, string> => "get" in files;

const fileMapGet = (
	files: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
	path: string,
): string | undefined => (isReadonlyMap(files) ? files.get(path) : files[path]);

export const makeFakeSpawnerServices = (input: FakeSpawnerServicesInput): LaunchServices => ({
	readText: (path) => {
		const value = fileMapGet(input.files, path);
		if (value === undefined) throw new Error(`fake spawner missing file: ${path}`);
		return value;
	},
	env: (key) => input.env?.[key],
	spawnProcess: () => (input.spawnPid === undefined ? {} : { pid: input.spawnPid }),
	execFile: () => input.commandResult ?? { status: 0, stdout: "1", stderr: "" },
});

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
