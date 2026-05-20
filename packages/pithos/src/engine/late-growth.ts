import { Effect } from "effect";
import type { Db } from "../db.js";
import { sql } from "../db.js";
import { fail } from "../errors.js";
import { withCollisionGuard } from "./db-helpers.js";
import { branchClosure, canonicalTaskId, taskEdges } from "./task-read-model.js";
import type { EngineContext } from "./types.js";

const terminalTaskStatuses = ["done", "failed", "dead_letter", "cancelled"] as const;

type BranchMembershipEdgeKind = "after" | "about" | "repair";

interface GateReleaseRow {
	readonly task_id: string;
	readonly target_task_id: string;
	readonly attempt: number;
}

export type LateGrowthMutation =
	| {
			readonly kind: "edge_inserted";
			readonly edgeTaskId: string;
			readonly edgeTargetTaskId: string;
			readonly edgeKind: BranchMembershipEdgeKind;
	  }
	| {
			readonly kind: "supersession";
			readonly supersededTaskId: string;
			readonly replacementTaskId: string;
	  };

const isTerminalTask = (db: Db, taskId: string): boolean => {
	const status = db
		.prepare(sql`SELECT status FROM tasks WHERE id=?`)
		.pluck()
		.get(taskId) as string | undefined;
	if (status === undefined) fail("NOT_FOUND", `task not found: ${taskId}`);
	return terminalTaskStatuses.includes(status as (typeof terminalTaskStatuses)[number]);
};

const releasedGatesAffectedByCanonicalTask = (
	db: Db,
	canonicalTaskIdToCheck: string,
): readonly GateReleaseRow[] => {
	const releases = db
		.prepare(sql`SELECT task_id, target_task_id, attempt FROM task_gate_releases`)
		.all() as GateReleaseRow[];
	return releases.filter((release) => {
		const inReleaseSnapshot =
			db
				.prepare(sql`
					SELECT 1
					FROM task_gate_release_members
					WHERE task_id=?
					  AND target_task_id=?
					  AND attempt=?
					  AND canonical_task_id=?
				`)
				.get(release.task_id, release.target_task_id, release.attempt, canonicalTaskIdToCheck) !==
			undefined;
		if (inReleaseSnapshot) return true;
		return branchClosure(db, release.target_task_id).some(
			(member) => member.canonical_task_id === canonicalTaskIdToCheck,
		);
	});
};

const downstreamImpactClosure = (db: Db, gateOwnerTaskId: string): readonly string[] => {
	const impact = new Set<string>([canonicalTaskId(db, gateOwnerTaskId)]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of taskEdges(db).filter((row) => row.kind !== "gate")) {
			if (!impact.has(canonicalTaskId(db, edge.target_task_id))) continue;
			const owner = canonicalTaskId(db, edge.task_id);
			if (impact.has(owner)) continue;
			impact.add(owner);
			changed = true;
		}
		const gateReleases = db
			.prepare(sql`SELECT task_id, target_task_id FROM task_gate_releases`)
			.all() as {
			readonly task_id: string;
			readonly target_task_id: string;
		}[];
		for (const release of gateReleases) {
			if (!impact.has(canonicalTaskId(db, release.target_task_id))) continue;
			const owner = canonicalTaskId(db, release.task_id);
			if (impact.has(owner)) continue;
			impact.add(owner);
			changed = true;
		}
	}
	return [...impact].sort();
};

export const enforceReleasedGateLateGrowth = (
	ctx: EngineContext,
	db: Db,
	actorRunId: string,
	affectedTaskId: string,
	mutation: LateGrowthMutation,
): void => {
	for (const release of releasedGatesAffectedByCanonicalTask(
		db,
		canonicalTaskId(db, affectedTaskId),
	)) {
		const impact = downstreamImpactClosure(db, release.task_id);
		const activeTaskId = impact.find((taskId) => !isTerminalTask(db, taskId));
		if (activeTaskId !== undefined) {
			fail(
				"VALIDATION_ERROR",
				`late branch growth under released gate ${release.task_id} -> ${release.target_task_id} attempt ${release.attempt} would affect non-terminal downstream task ${activeTaskId}`,
			);
		}
		const markerId = Effect.runSync(ctx.services.ids.make("marker"));
		withCollisionGuard(markerId, () =>
			db
				.prepare(sql`
					INSERT INTO task_gate_late_growth_markers(
						id,
						gate_task_id,
						gate_target_task_id,
						gate_attempt,
						mutation_kind,
						edge_task_id,
						edge_target_task_id,
						edge_kind,
						superseded_task_id,
						replacement_task_id,
						created_by_run_id
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.run(
					markerId,
					release.task_id,
					release.target_task_id,
					release.attempt,
					mutation.kind,
					mutation.kind === "edge_inserted" ? mutation.edgeTaskId : null,
					mutation.kind === "edge_inserted" ? mutation.edgeTargetTaskId : null,
					mutation.kind === "edge_inserted" ? mutation.edgeKind : null,
					mutation.kind === "supersession" ? mutation.supersededTaskId : null,
					mutation.kind === "supersession" ? mutation.replacementTaskId : null,
					actorRunId,
				),
		);
	}
};
