import { Effect, ParseResult, Schema } from "effect";
import { resolve } from "node:path";
import { PdxError } from "./errors.js";

export const RawPdxConfigSchema = Schema.Struct({
	dataDir: Schema.optional(Schema.NonEmptyString),
	envDataDir: Schema.optional(Schema.NonEmptyString),
	envHome: Schema.optional(Schema.NonEmptyString),
	daemonEntrypoint: Schema.NonEmptyString,
});

export interface PdxConfig {
	readonly dataDir: string;
	readonly socketPath: string;
	readonly logPath: string;
	readonly runsDir: string;
	readonly daemonEntrypoint: string;
	readonly pithosDbPath: string;
}

export const parsePdxConfig = (input: unknown): Effect.Effect<PdxConfig, PdxError> =>
	Schema.decodeUnknown(RawPdxConfigSchema)(input, { errors: "all" }).pipe(
		Effect.mapError(
			(error) =>
				new PdxError({
					code: "CONFIG_ERROR",
					message: `Invalid pdx config: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
				}),
		),
		Effect.flatMap((decoded) => {
			if (
				decoded.dataDir === undefined &&
				decoded.envDataDir === undefined &&
				decoded.envHome === undefined
			) {
				return Effect.fail(
					new PdxError({
						code: "CONFIG_ERROR",
						message: "missing required data dir (provide --data-dir, PDX_DATA_DIR, or HOME env)",
					}),
				);
			}
			const dataDir = resolve(decoded.dataDir ?? decoded.envDataDir ?? `${decoded.envHome}/.pdx`);
			return Effect.succeed({
				dataDir,
				socketPath: `${dataDir}/pdx.sock`,
				logPath: `${dataDir}/pdx.jsonl`,
				runsDir: `${dataDir}/runs`,
				daemonEntrypoint: decoded.daemonEntrypoint,
				pithosDbPath: `${dataDir}/pithos.sqlite`,
			});
		}),
	);
