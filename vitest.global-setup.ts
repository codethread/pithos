import { execSync } from "node:child_process";

export default function setup() {
	execSync("pnpm --filter @pithos/pithos build", { stdio: "inherit" });
}
