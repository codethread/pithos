import { Effect, ParseResult, Schema } from "effect";
import { resolve } from "node:path";
import { PdxError } from "./errors.js";

export const RawPdxConfigSchema = Schema.Struct({
	home: Schema.optional(Schema.NonEmptyString),
	envHome: Schema.optional(Schema.NonEmptyString),
	daemonEntrypoint: Schema.NonEmptyString,
});

export interface PdxConfig {
	readonly home: string;
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
			if (decoded.home === undefined && decoded.envHome === undefined) {
				return Effect.fail(
					new PdxError({
						code: "CONFIG_ERROR",
						message: "missing required home (provide --home or HOME env)",
					}),
				);
			}
			const home = resolve(decoded.home ?? `${decoded.envHome}/.pdx`);
			return Effect.succeed({
				home,
				socketPath: `${home}/pdx.sock`,
				logPath: `${home}/pdx.jsonl`,
				runsDir: `${home}/runs`,
				daemonEntrypoint: decoded.daemonEntrypoint,
				pithosDbPath: `${home}/pithos.sqlite`,
			});
		}),
	);
