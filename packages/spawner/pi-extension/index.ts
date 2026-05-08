import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const dispatchPath = resolve(here, "..", "hooks", "dispatch.sh");
const loadedKey = "__pithosSpawnerPiExtensionLoaded__";

const dispatch = (event: "PreToolUse" | "SessionEnd"): void => {
	spawnSync("bash", [dispatchPath, event], { stdio: "ignore" });
};

const isManagedSession = (ctx: ExtensionContext): boolean => {
	const expectedSessionId = process.env.PITHOS_SESSION_ID;
	return expectedSessionId !== undefined && ctx.sessionManager.getSessionId() === expectedSessionId;
};

export default function (pi: ExtensionAPI) {
	const runtime = globalThis as typeof globalThis & { [loadedKey]?: boolean };
	if (runtime[loadedKey] === true) return;
	runtime[loadedKey] = true;

	pi.on("tool_call", (_event, ctx) => {
		if (isManagedSession(ctx)) dispatch("PreToolUse");
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason !== "reload" && isManagedSession(ctx)) dispatch("SessionEnd");
	});
}
