import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import process from "node:process";
import { inspect } from "node:util";
import { runPithosCli } from "./cli.js";
import { loadConfig } from "./config.js";
import { liveServices } from "./services.js";

const program = runPithosCli(
	{
		config: () => loadConfig({ get: (name) => process.env[name] }),
		services: liveServices,
	},
	process.argv,
).pipe(
	Effect.catchAll((error) =>
		Effect.sync(() => {
			const message = error instanceof Error ? error.message : inspect(error);
			Effect.runSync(
				liveServices.output.writeError(
					`${JSON.stringify({
						ok: false,
						error: { code: "VALIDATION_ERROR", message },
					})}\n`,
				),
			);
			process.exitCode = 2;
		}),
	),
);

NodeRuntime.runMain(program);
