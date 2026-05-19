import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SpawnedProcess {
	readonly pid?: number;
	readonly once?: (event: "error", listener: (error: Error) => void) => unknown;
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
	readonly realPath: (path: string) => string;
}

export interface LaunchServices extends RenderServices {
	readonly spawnProcess: (
		file: string,
		args: readonly string[],
		options: { readonly cwd: string; readonly env: Record<string, string> },
	) => SpawnedProcess;
	readonly writeTempText: (prefix: string, content: string) => string;
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
		if (value === undefined) {
			throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
				code: "ENOENT",
			});
		}
		return value;
	},
	env: (key) => input.env?.[key],
	spawnProcess: () => (input.spawnPid === undefined ? {} : { pid: input.spawnPid }),
	writeTempText: (prefix, content) => `${prefix}-${content.length}.tmp`,
	execFile: () => input.commandResult ?? { status: 0, stdout: "1", stderr: "" },
	realPath: (path) => path,
});

const formatSpawnSyncError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

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
		const once = child.once.bind(child) as NonNullable<SpawnedProcess["once"]>;
		return child.pid === undefined ? { once } : { pid: child.pid, once };
	},
	writeTempText: (prefix, content) => {
		const path = join(tmpdir(), `${prefix}-${randomUUID()}.md`);
		writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
		return path;
	},
	execFile: (file, args) => {
		const result = spawnSync(file, args, { encoding: "utf8" });
		return {
			status: result.status,
			stdout: result.stdout ?? "",
			stderr:
				result.stderr ?? (result.error === undefined ? "" : formatSpawnSyncError(result.error)),
		};
	},
	realPath: (path) => realpathSync(path),
};
