import { Effect, ParseResult, Schema } from "effect";
import { PdxError } from "./errors.js";

export const IpcRequestSchema = Schema.Union(
	Schema.Struct({ kind: Schema.Literal("ping") }),
	Schema.Struct({ kind: Schema.Literal("status") }),
	Schema.Struct({ kind: Schema.Literal("stop") }),
);
export type IpcRequest = Schema.Schema.Type<typeof IpcRequestSchema>;

export const IpcResponseSchema = Schema.Struct({
	ok: Schema.Boolean,
	data: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
	error: Schema.optional(Schema.String),
});
export type IpcResponse = Schema.Schema.Type<typeof IpcResponseSchema>;

const parseJson = (input: string, label: string): Effect.Effect<unknown, PdxError> =>
	Effect.try({
		try: () => JSON.parse(input) as unknown,
		catch: (cause) =>
			new PdxError({ code: "IPC_ERROR", message: `Malformed IPC ${label}: ${String(cause)}` }),
	});

export const parseIpcRequest = (input: string): Effect.Effect<IpcRequest, PdxError> =>
	parseJson(input, "request JSON").pipe(
		Effect.flatMap((value) =>
			Schema.decodeUnknown(IpcRequestSchema)(value, { errors: "all" }).pipe(
				Effect.mapError(
					(error) =>
						new PdxError({
							code: "IPC_ERROR",
							message: `Invalid IPC request: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
						}),
				),
			),
		),
	);

export const parseIpcResponse = (input: string): Effect.Effect<IpcResponse, PdxError> =>
	parseJson(input, "response JSON").pipe(
		Effect.flatMap((value) =>
			Schema.decodeUnknown(IpcResponseSchema)(value, { errors: "all" }).pipe(
				Effect.mapError(
					(error) =>
						new PdxError({
							code: "IPC_ERROR",
							message: `Invalid IPC response: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
						}),
				),
			),
		),
	);
