import { Schema } from "effect";
import { resolve } from "node:path";
import { PdxError } from "./errors.js";

export const RawPdxConfigSchema = Schema.Struct({
	home: Schema.optional(Schema.NonEmptyString),
	envHome: Schema.NonEmptyString,
	daemonEntrypoint: Schema.NonEmptyString,
});

export interface PdxConfig {
	readonly home: string;
	readonly socketPath: string;
	readonly logPath: string;
	readonly runsDir: string;
	readonly daemonEntrypoint: string;
}

export const parsePdxConfig = (input: unknown): PdxConfig => {
	const decoded = Schema.decodeUnknownSync(RawPdxConfigSchema)(input, { errors: "all" });
	const home = resolve(decoded.home ?? `${decoded.envHome}/.pdx`);
	return {
		home,
		socketPath: `${home}/pdx.sock`,
		logPath: `${home}/pdx.jsonl`,
		runsDir: `${home}/runs`,
		daemonEntrypoint: decoded.daemonEntrypoint,
	};
};

export const parsePdxConfigOrThrow = (input: unknown): PdxConfig => {
	try {
		return parsePdxConfig(input);
	} catch (cause) {
		throw new PdxError({
			code: "CONFIG_ERROR",
			message: `Invalid pdx config: ${String(cause)}`,
		});
	}
};
