import { CliConfig, Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import process from "node:process";
import { inspect } from "node:util";
import { makePithosCommand } from "./cli.js";
import { loadConfig } from "./config.js";
import { liveServices } from "./services.js";

const command = makePithosCommand({
	config: () => loadConfig({ get: (name) => process.env[name] }),
	services: liveServices,
});
const cli = Command.run(command, { name: "Pithos", version: "0.1.0", executable: "pithos-next" });

const program = cli(process.argv).pipe(
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
	Effect.provide(Layer.mergeAll(NodeContext.layer, CliConfig.layer({ showBuiltIns: false }))),
);

NodeRuntime.runMain(program);
