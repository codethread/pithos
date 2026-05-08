import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import process from "node:process";
import { Context, Layer } from "effect";

export interface FsService {
	readonly readText: (path: string) => string;
	readonly removeFile: (path: string) => void;
}

export interface IdService {
	readonly make: (prefix: string) => string;
}

export interface ClockService {
	readonly nowIso: () => string;
}

export interface OutputService {
	readonly write: (text: string) => void;
	readonly writeError: (text: string) => void;
}

export interface Services {
	readonly fs: FsService;
	readonly output: OutputService;
	readonly ids: IdService;
	readonly clock: ClockService;
}

export class PithosServices extends Context.Tag("PithosServices")<PithosServices, Services>() {}

export const liveServices: Services = {
	fs: {
		readText: (path) => readFileSync(path, "utf8"),
		removeFile: (path) => rmSync(path, { force: true }),
	},
	output: {
		write: (text) => process.stdout.write(text),
		writeError: (text) => process.stderr.write(text),
	},
	ids: {
		make: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
	},
	clock: {
		nowIso: () => new Date().toISOString(),
	},
};

export const LiveServicesLayer = Layer.succeed(PithosServices, liveServices);
