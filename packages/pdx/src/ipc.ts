import { Schema } from "effect";
import { PdxError } from "./errors.js";

export const IpcRequestSchema = Schema.Union(
	Schema.Struct({ kind: Schema.Literal("ping") }),
	Schema.Struct({ kind: Schema.Literal("status") }),
);
export type IpcRequest = Schema.Schema.Type<typeof IpcRequestSchema>;

export const IpcResponseSchema = Schema.Struct({
	ok: Schema.Boolean,
	data: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
	error: Schema.optional(Schema.String),
});
export type IpcResponse = Schema.Schema.Type<typeof IpcResponseSchema>;

const parseJson = (input: string, label: string): unknown => {
	try {
		return JSON.parse(input);
	} catch (cause) {
		throw new PdxError({ code: "IPC_ERROR", message: `Malformed IPC ${label}: ${String(cause)}` });
	}
};

export const parseIpcRequest = (input: string): IpcRequest => {
	try {
		return Schema.decodeUnknownSync(IpcRequestSchema)(parseJson(input, "request JSON"), {
			errors: "all",
		});
	} catch (cause) {
		if (cause instanceof PdxError) throw cause;
		throw new PdxError({ code: "IPC_ERROR", message: `Invalid IPC request: ${String(cause)}` });
	}
};

export const parseIpcResponse = (input: string): IpcResponse => {
	try {
		return Schema.decodeUnknownSync(IpcResponseSchema)(parseJson(input, "response JSON"), {
			errors: "all",
		});
	} catch (cause) {
		if (cause instanceof PdxError) throw cause;
		throw new PdxError({ code: "IPC_ERROR", message: `Invalid IPC response: ${String(cause)}` });
	}
};
