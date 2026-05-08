import { execSync } from "node:child_process";

export default function setup() {
	execSync("pnpm --filter @pithos/cli build", { stdio: "inherit" });
}
