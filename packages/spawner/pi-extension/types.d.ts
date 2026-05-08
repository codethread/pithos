declare module "@mariozechner/pi-coding-agent" {
	export interface SessionShutdownEvent {
		readonly reason: "quit" | "reload" | "new" | "resume" | "fork";
	}

	export interface SessionManager {
		getSessionId(): string;
	}

	export interface ExtensionContext {
		readonly sessionManager: SessionManager;
	}

	export interface ExtensionAPI {
		on(
			event: "tool_call",
			handler: (_event: unknown, ctx: ExtensionContext) => void | Promise<void>,
		): void;
		on(
			event: "session_shutdown",
			handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => void | Promise<void>,
		): void;
	}
}
