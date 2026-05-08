import { CliConfig, Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import process from "node:process";
import { makePithosCommand } from "./cli.js";
import { loadConfig } from "./config.js";
import { liveServices } from "./services.js";

const config = loadConfig({ get: (name) => process.env[name] });
const command = makePithosCommand({ config, services: liveServices });
const cli = Command.run(command, { name: "Pithos", version: "0.1.0", executable: "pithos-next" });

const program = cli(process.argv).pipe(
	Effect.catchAll(() => Effect.sync(() => process.exit(2))),
	Effect.provide(Layer.mergeAll(NodeContext.layer, CliConfig.layer({ showBuiltIns: false }))),
);

NodeRuntime.runMain(program);
