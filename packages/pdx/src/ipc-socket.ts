import { Effect } from "effect";
import { rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { PdxError } from "./errors.js";
import { parseIpcRequest, parseIpcResponse, type IpcRequest, type IpcResponse } from "./ipc.js";

export interface IpcServerHandle {
	readonly close: Effect.Effect<void, PdxError>;
}

const unlinkSocket = (socketPath: string) =>
	Effect.tryPromise({
		try: () => rm(socketPath, { force: true }),
		catch: (error) =>
			new PdxError({ code: "IPC_ERROR", message: `IPC socket unlink failed: ${String(error)}` }),
	}).pipe(Effect.asVoid);

const errorResponse = (error: unknown): IpcResponse =>
	error instanceof PdxError
		? { ok: false, error: `${error.code}: ${error.message}` }
		: { ok: false, error: `IPC_ERROR: ${String(error)}` };

export const listenIpc = (
	socketPath: string,
	handle: (request: IpcRequest) => Effect.Effect<IpcResponse, PdxError>,
): Effect.Effect<IpcServerHandle, PdxError> =>
	unlinkSocket(socketPath).pipe(
		Effect.zipRight(
			Effect.async<IpcServerHandle, PdxError>((resume) => {
				const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
					let input = "";
					socket.setEncoding("utf8");
					socket.on("data", (chunk: string) => {
						input += chunk;
					});
					socket.on("end", () => {
						const request = parseIpcRequest(input);
						const response = Effect.flatMap(request, (request) =>
							Effect.match(handle(request), {
								onFailure: errorResponse,
								onSuccess: (value) => value,
							}),
						);
						Effect.runPromise(response)
							.then((value) => socket.end(`${JSON.stringify(value)}\n`))
							.catch((cause: unknown) => socket.end(`${JSON.stringify(errorResponse(cause))}\n`));
					});
				});
				server.once("error", (error) => {
					resume(
						Effect.fail(
							new PdxError({ code: "IPC_ERROR", message: `IPC listen failed: ${error.message}` }),
						),
					);
				});
				server.listen(socketPath, () => {
					resume(
						Effect.succeed({
							close: Effect.async((closeResume) => {
								server.close((error) => {
									closeResume(
										error === undefined
											? unlinkSocket(socketPath)
											: Effect.fail(
													new PdxError({
														code: "IPC_ERROR",
														message: `IPC close failed: ${error.message}`,
													}),
												),
									);
								});
							}),
						}),
					);
				});
			}),
		),
	);

export const requestIpc = (
	socketPath: string,
	request: IpcRequest,
): Effect.Effect<IpcResponse, PdxError> =>
	Effect.async((resume) => {
		const socket = createConnection(socketPath);
		let output = "";
		socket.setEncoding("utf8");
		socket.once("error", (error) => {
			resume(
				Effect.fail(
					new PdxError({ code: "IPC_ERROR", message: `IPC request failed: ${error.message}` }),
				),
			);
		});
		socket.on("data", (chunk: string) => {
			output += chunk;
		});
		socket.on("end", () => {
			resume(parseIpcResponse(output));
		});
		socket.end(JSON.stringify(request));
	});
