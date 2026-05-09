import { parsePdxConfigOrThrow } from "./config.js";
import { PdxError } from "./errors.js";

const args = process.argv.slice(2);
const homeIndex = args.indexOf("--home");
const home = homeIndex === -1 ? `${process.env.HOME}/.pdx` : args[homeIndex + 1];
const commandArgs =
	homeIndex === -1
		? args
		: args.filter((_, index) => index !== homeIndex && index !== homeIndex + 1);

try {
	parsePdxConfigOrThrow({ home });
	const command = commandArgs.find((arg) => !arg.startsWith("--"));
	if (command === "--help" || command === undefined) {
		process.stdout.write("pdx substrate commands: open, close, status, kill, logs show\n");
		process.exit(0);
	}
	throw new PdxError({
		code: "VALIDATION_ERROR",
		message: `Command not implemented in substrate slice: ${command}`,
	});
} catch (error) {
	if (error instanceof PdxError) {
		process.stderr.write(`${error.code}: ${error.message}\n`);
		process.exit(2);
	}
	throw error;
}
