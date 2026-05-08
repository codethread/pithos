import { Either, Schema } from "effect";
import { fail } from "./errors.js";

export const ConfigSchema = Schema.Struct({
	dbPath: Schema.String,
	runId: Schema.optional(Schema.String),
});

export type Config = typeof ConfigSchema.Type;

export interface EnvReader {
	readonly get: (name: string) => string | undefined;
}

export const loadConfig = (env: EnvReader): Config => {
	const raw = {
		dbPath: env.get("PITHOS_DB") ?? "./pithos.db",
		runId: env.get("PITHOS_RUN_ID"),
	};
	const result = Schema.decodeUnknownEither(ConfigSchema)(raw);
	return Either.match(result, {
		onLeft: () => fail("VALIDATION_ERROR", "invalid process configuration"),
		onRight: (config) => config,
	});
};
