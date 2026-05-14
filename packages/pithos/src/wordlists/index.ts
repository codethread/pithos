import { randomInt } from "node:crypto";
import words from "./eff-short.json" with { type: "json" };

// EFF short list is already filtered; additionally exclude a small set of
// words that would produce unpleasant combinations in generated IDs.
const BLOCKLIST = new Set(["gore", "hate", "hurt"]);

const pool: string[] = words.filter((w) => !BLOCKLIST.has(w));

// Exported for tests that want deterministic IDs.
export type Rng = () => number;

const defaultRng: Rng = () => randomInt(pool.length);

export const pickThreeWords = (rng: Rng = defaultRng): string =>
	`${pool[rng()]}-${pool[rng()]}-${pool[rng()]}`;
