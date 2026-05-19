import { Either, Schema } from "effect";
import { fail } from "./errors.js";

const RequiredEnvString = Schema.String.pipe(Schema.minLength(1));

export const ConfigSchema = Schema.Struct({
	dbPath: RequiredEnvString,
	runId: Schema.optional(RequiredEnvString),
	homeDir: Schema.optional(RequiredEnvString),
});

export type Config = typeof ConfigSchema.Type;

export interface EnvReader {
	readonly get: (name: string) => string | undefined;
}

export const loadConfig = (env: EnvReader): Config => {
	const rawRunId = env.get("PITHOS_RUN_ID");
	const rawHomeDir = env.get("HOME");
	const raw = {
		dbPath: env.get("PITHOS_DB"),
		runId: rawRunId === "" ? undefined : rawRunId,
		homeDir: rawHomeDir === "" ? undefined : rawHomeDir,
	};
	const result = Schema.decodeUnknownEither(ConfigSchema)(raw);
	return Either.match(result, {
		onLeft: () => fail("VALIDATION_ERROR", "invalid process configuration: PITHOS_DB is required"),
		onRight: (config) => config,
	});
};
