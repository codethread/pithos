import { execSync } from "node:child_process";

export default function setup() {
	execSync("pnpm --filter @pdx/pithos build", { stdio: "inherit" });
}
