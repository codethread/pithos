import { Effect } from "effect";
import { PdxError } from "./errors.js";
import { Process, Tmux, type TmuxService } from "./services.js";

const requireOk = (command: string, exitCode: number, stderr: string) =>
	exitCode === 0
		? Effect.void
		: Effect.fail(new PdxError({ code: "PROCESS_ERROR", message: `${command} failed: ${stderr}` }));

export const makeTmux = Effect.gen(function* () {
	const processService = yield* Process;
	const service: TmuxService = {
		hasSession: (target) =>
			processService.execFile("tmux", ["has-session", "-t", target]).pipe(
				Effect.flatMap((result) => {
					if (result.exitCode === 0) return Effect.succeed(true);
					if (
						result.stderr.includes("can't find session") ||
						result.stderr.includes("no server running")
					) {
						return Effect.succeed(false);
					}
					return Effect.fail(
						new PdxError({
							code: "PROCESS_ERROR",
							message: `tmux has-session failed: ${result.stderr}`,
						}),
					);
				}),
			),
		lsSessions: () =>
			processService.execFile("tmux", ["ls", "-F", "#S"]).pipe(
				Effect.flatMap((result) => {
					if (result.exitCode !== 0 && result.stderr.includes("no server running"))
						return Effect.succeed([]);
					return requireOk("tmux ls", result.exitCode, result.stderr).pipe(
						Effect.as(result.stdout.split("\n").filter(Boolean)),
					);
				}),
			),
		newSession: ({ target, command, cwd }) =>
			processService
				.execFile("tmux", ["new-session", "-d", "-s", target, "-c", cwd, ...command])
				.pipe(
					Effect.flatMap((result) => requireOk("tmux new-session", result.exitCode, result.stderr)),
				),
		killSession: (target) =>
			processService
				.execFile("tmux", ["kill-session", "-t", target])
				.pipe(
					Effect.flatMap((result) =>
						requireOk("tmux kill-session", result.exitCode, result.stderr),
					),
				),
		switchClient: (target) =>
			processService
				.execFile("tmux", ["switch-client", "-t", target])
				.pipe(
					Effect.flatMap((result) =>
						requireOk("tmux switch-client", result.exitCode, result.stderr),
					),
				),
		sendLiteralLine: (target, text) =>
			processService.execFile("tmux", ["send-keys", "-t", target, "-l", "--", text]).pipe(
				Effect.flatMap((result) =>
					requireOk("tmux send-keys text", result.exitCode, result.stderr),
				),
				Effect.zipRight(processService.execFile("tmux", ["send-keys", "-t", target, "Enter"])),
				Effect.flatMap((result) =>
					requireOk("tmux send-keys enter", result.exitCode, result.stderr),
				),
			),
		pasteBuffer: (target, content) =>
			processService.execFile("tmux", ["set-buffer", content]).pipe(
				Effect.flatMap((result) => requireOk("tmux set-buffer", result.exitCode, result.stderr)),
				Effect.zipRight(processService.execFile("tmux", ["paste-buffer", "-t", target])),
				Effect.flatMap((result) => requireOk("tmux paste-buffer", result.exitCode, result.stderr)),
			),
	};
	return Tmux.of(service);
});
