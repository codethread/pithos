import { migrate, openDb, type Db } from "../db.js";
import { fail } from "../errors.js";
import type { EngineContext } from "./types.js";

// Surfaces SQLite PRIMARY KEY constraint violations as ID_COLLISION errors.
// The transaction rolls back automatically (better-sqlite3 throws on error).
export const withCollisionGuard = <A>(id: string, fn: () => A): A => {
	try {
		return fn();
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
		) {
			fail("ID_COLLISION", `generated ID already exists: ${id}`);
		}
		throw error;
	}
};

export const withDb = <A>(ctx: EngineContext, f: (db: Db) => A): A => {
	const db = openDb(ctx.config.dbPath);
	migrate(db);
	try {
		return f(db);
	} finally {
		db.close();
	}
};
