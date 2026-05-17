import { Effect, ParseResult, Schema } from "effect";
import { relative, resolve, sep } from "node:path";
import { PdxError } from "./errors.js";

export const RawPdxConfigSchema = Schema.Struct({
	dataDir: Schema.optional(Schema.NonEmptyString),
	envDataDir: Schema.optional(Schema.NonEmptyString),
	envUserDataDir: Schema.optional(Schema.NonEmptyString),
	envHome: Schema.optional(Schema.NonEmptyString),
	daemonEntrypoint: Schema.NonEmptyString,
});

export interface PdxConfig {
	readonly dataDir: string;
	readonly userDataDir: string;
	readonly socketPath: string;
	readonly logPath: string;
	readonly runsDir: string;
	readonly daemonEntrypoint: string;
	readonly pithosDbPath: string;
}

const isSamePath = (left: string, right: string): boolean => left === right;

const isAncestorPath = (ancestor: string, path: string): boolean => {
	const rel = relative(ancestor, path);
	return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && rel !== ".";
};

const validateUserDataDir = (
	dataDir: string,
	rawUserDataDir: string | undefined,
	envHome: string | undefined,
): Effect.Effect<string, PdxError> => {
	const defaultUserDataDir = resolve(dataDir, "config");
	const userDataDir =
		rawUserDataDir === undefined
			? defaultUserDataDir
			: rawUserDataDir === "~"
				? envHome === undefined
					? "__missing_home__"
					: resolve(envHome)
				: rawUserDataDir.startsWith("~/")
					? envHome === undefined
						? "__missing_home__"
						: resolve(envHome, rawUserDataDir.slice(2))
					: resolve(rawUserDataDir);
	if (userDataDir === "__missing_home__") {
		return Effect.fail(
			new PdxError({
				code: "CONFIG_ERROR",
				message: "PDX_USER_DATA_DIR uses ~/ but HOME env is missing",
			}),
		);
	}
	if (isSamePath(userDataDir, dataDir)) {
		return Effect.fail(
			new PdxError({
				code: "CONFIG_ERROR",
				message: `PDX_USER_DATA_DIR must not equal PDX_DATA_DIR: ${dataDir}`,
			}),
		);
	}
	if (isAncestorPath(userDataDir, dataDir)) {
		return Effect.fail(
			new PdxError({
				code: "CONFIG_ERROR",
				message: `PDX_USER_DATA_DIR must not be an ancestor of PDX_DATA_DIR: ${userDataDir} -> ${dataDir}`,
			}),
		);
	}
	if (isAncestorPath(dataDir, userDataDir) && !isSamePath(userDataDir, defaultUserDataDir)) {
		return Effect.fail(
			new PdxError({
				code: "CONFIG_ERROR",
				message: `PDX_USER_DATA_DIR inside PDX_DATA_DIR is only allowed at ${defaultUserDataDir}; got ${userDataDir}`,
			}),
		);
	}
	return Effect.succeed(userDataDir);
};

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
			return validateUserDataDir(dataDir, decoded.envUserDataDir, decoded.envHome).pipe(
				Effect.map((userDataDir) => ({
					dataDir,
					userDataDir,
					socketPath: `${dataDir}/pdx.sock`,
					logPath: `${dataDir}/pdx.jsonl`,
					runsDir: `${dataDir}/runs`,
					daemonEntrypoint: decoded.daemonEntrypoint,
					pithosDbPath: `${dataDir}/pithos.sqlite`,
				})),
			);
		}),
	);
