import type { ChainPolicy, ChainPolicyDecision } from "../chain-policy.js";
import type { Config } from "../config.js";
import type {
	Capability,
	EdgeKind,
	HarnessKind,
	Mode,
	ScopeKind,
	SourceKind,
	TaskStatus,
} from "../db.js";
import type { RepairAlertKind, TaskGateLateGrowthMarkerRow } from "../rows.js";
import type { Services } from "../services.js";

export const PDX_SYSTEM_RUN_ID = "run_pdx_system";

export interface EngineContext {
	readonly config: Config;
	readonly services: Services;
}

export interface Engine {
	readonly init: (input: { readonly fresh: boolean }) => { readonly ok: true };
	readonly scopeUpsert: (input: {
		readonly kind: ScopeKind;
		readonly path: string | undefined;
		readonly parentRepoPath?: string | undefined;
		readonly description?: string | undefined;
	}) => {
		readonly ok: true;
		readonly scope: ScopeIdentityOutput;
	};
	readonly scopeList: (input: { readonly all: boolean }) => {
		readonly ok: true;
		readonly scopes: readonly ScopeOutput[];
	};
	readonly scopeArchive: (input: { readonly scopeId: string }) => {
		readonly ok: true;
		readonly action: "archived" | "deleted";
		readonly scope: ScopeOutput;
	};
	readonly runUpsert: (input: {
		readonly agent: string;
		readonly mode: Mode;
		readonly scope: string;
		readonly cwd: string;
		readonly harnessKind: HarnessKind;
		readonly sessionLogPath: string;
		readonly sessionId: string;
		readonly runId: string | undefined;
	}) => { readonly ok: true; readonly run: RunOutput };
	readonly runInspect: (input: { readonly runId: string }) => {
		readonly ok: true;
		readonly run: RunOutput;
	};
	readonly activeRunForTask: (input: { readonly taskId: string }) => {
		readonly ok: true;
		readonly run: RunOutput | null;
	};
	readonly runCleanup: (input: { readonly runId: string; readonly reason: string }) => {
		readonly ok: true;
		readonly run: RunOutput;
	};
	readonly runInterrupt: (input: {
		readonly runId: string | undefined;
		readonly taskId: string | undefined;
		readonly reason: string;
		readonly expectedRunId?: string;
	}) => {
		readonly ok: true;
		readonly run: RunOutput;
		readonly interrupted_task: { readonly id: string; readonly scope_id: string } | null;
	};
	readonly runTimeout: (input: { readonly runId: string; readonly reason: string }) => {
		readonly ok: true;
		readonly run: RunOutput;
	};
	readonly runLaunchAbort: (input: { readonly runId: string; readonly reason: string }) => {
		readonly ok: true;
		readonly run: RunOutput;
	};
	readonly eventsTail: (input: { readonly limit: number | undefined }) => {
		readonly ok: true;
		readonly events: readonly EventOutput[];
	};
	readonly pruneEvents: (input?: {
		readonly heartbeatOlderThanDays?: number;
		readonly otherOlderThanDays?: number;
	}) => {
		readonly ok: true;
		readonly deleted_heartbeat: number;
		readonly deleted_other: number;
	};
	readonly enqueue: (input: {
		readonly scope: string;
		readonly capability: Capability;
		readonly title: string;
		readonly body: string | undefined;
		readonly bodyFile: string | undefined;
		readonly runId: string | undefined;
		readonly after: readonly string[];
		readonly gate?: readonly string[] | undefined;
		readonly about?: string | undefined;
		readonly repair?: string | undefined;
		readonly chain: ChainPolicy;
	}) => EnqueueOutput;
	readonly claim: (input: {
		readonly runId: string | undefined;
		readonly scope: string;
		readonly capability: Capability;
	}) => {
		readonly ok: true;
		readonly task: {
			readonly id: string;
			readonly status: "claimed";
			readonly token: number;
			readonly capability: Capability;
		};
	};
	readonly heartbeat: (input: {
		readonly runId: string | undefined;
		readonly taskId: string | undefined;
		readonly token: number | undefined;
	}) => { readonly ok: true; readonly status: string };
	readonly complete: (input: {
		readonly taskId: string;
		readonly runId: string | undefined;
		readonly token: number;
		readonly resultJson: string;
	}) => { readonly ok: true; readonly task: { readonly id: string; readonly status: "done" } };
	readonly failTask: (input: {
		readonly taskId: string;
		readonly runId: string | undefined;
		readonly token: number;
		readonly reason: string;
	}) => { readonly ok: true; readonly task: { readonly id: string; readonly status: "failed" } };
	readonly artifactAdd: (input: {
		readonly taskId: string;
		readonly runId: string | undefined;
		readonly kind: string;
		readonly title: string;
		readonly body: string;
	}) => { readonly ok: true; readonly artifact: { readonly id: string } };
	readonly taskInspect: (input: { readonly taskId: string }) => TaskInspectOutput;
	readonly cancel: (input: {
		readonly taskId: string;
		readonly runId: string | undefined;
		readonly reason: string;
	}) => { readonly ok: true; readonly task: { readonly id: string; readonly status: "cancelled" } };
	readonly graphInspect: (input: {
		readonly taskId: string | undefined;
		readonly scope: string | undefined;
		readonly all: boolean;
		readonly status?: readonly TaskStatus[];
		readonly search?: readonly string[];
		readonly sinceCutoff?: GraphSinceCutoff | undefined;
	}) => GraphInspectOutput;
	readonly briefing: (input: { readonly agent: string | undefined }) => BriefingOutput;
	readonly supersede: (input: {
		readonly taskId: string;
		readonly runId: string | undefined;
		readonly reason: string;
		readonly title: string | undefined;
		readonly body: string | undefined;
		readonly bodyFile: string | undefined;
		readonly scope: string | undefined;
		readonly capability: Capability | undefined;
	}) => SupersedeOutput;
	readonly escalateLaunchPrecondition: (input: {
		readonly runId: string | undefined;
		readonly expectedTaskId: string;
		readonly expectedScopeId: string;
		readonly expectedCapability: Capability;
		readonly canonicalPath: string;
		readonly agentKind: string;
		readonly reason: string;
		readonly escalationTitle: string;
		readonly escalationBody: string;
	}) => LaunchPreconditionEscalationOutput;
	readonly createRepairAlert: (input: {
		readonly runId: string | undefined;
		readonly affectedTaskId?: string;
		readonly kind: RepairAlertKind;
		readonly escalationTitle: string;
		readonly escalationBody: string;
	}) => RepairAlertOutput;
	readonly claimableRepairAlertKinds: () => {
		readonly ok: true;
		readonly kinds: readonly RepairAlertKind[];
	};
}

export interface GraphSinceCutoff {
	readonly dbTimestamp: string;
}

export type Json =
	| null
	| boolean
	| number
	| string
	| readonly Json[]
	| { readonly [key: string]: Json };

export interface TaskSummaryOutput {
	readonly id: string;
	readonly scope_id: string;
	readonly scope_kind: ScopeKind;
	readonly canonical_path: string | null;
	readonly parent_repo_path: string | null;
	readonly scope_description: string | null;
	readonly capability: Capability;
	readonly status: TaskStatus;
	readonly title: string;
	readonly created_at: string;
	readonly completed_at: string | null;
}

export interface TaskDetailOutput extends TaskSummaryOutput {
	readonly body: string;
	readonly fencing_token: number;
	readonly attempts: number;
	readonly max_attempts: number;
}

export type GateState = "clear" | "open" | "broken";

export interface GateInspectOutput {
	readonly target_task_id: string;
	readonly state: GateState;
	readonly members: readonly {
		readonly task_id: string;
		readonly canonical_task_id: string;
		readonly status: TaskStatus;
	}[];
}

export interface TaskInspectTaskOutput extends TaskDetailOutput {
	readonly claimable: boolean;
	readonly unresolved_dependency_ids: readonly string[];
	readonly gates: readonly GateInspectOutput[];
}

export type LateGrowthMarkerOutput = TaskGateLateGrowthMarkerRow;

export interface LineageEntryOutput {
	readonly depth: number;
	readonly via_task_ids: readonly string[];
	readonly task: TaskInspectTaskOutput;
	readonly supersedes: string | null;
	readonly superseded_by: string | null;
	readonly artifacts: readonly ArtifactOutput[];
}

export interface TaskSourceSummaryOutput extends TaskSummaryOutput {
	readonly source_kind: Extract<EdgeKind, "about" | "repair">;
}

export interface TaskInspectOutput {
	readonly ok: true;
	readonly task: TaskInspectTaskOutput;
	readonly dependencies: readonly TaskDetailOutput[];
	readonly dependents: readonly TaskDetailOutput[];
	readonly source: TaskSourceSummaryOutput | null;
	readonly attached_context: readonly TaskSourceSummaryOutput[];
	readonly lineage: readonly LineageEntryOutput[];
	readonly supersedes: string | null;
	readonly superseded_by: string | null;
	readonly artifacts: readonly ArtifactOutput[];
	readonly repair_alert_kind: RepairAlertKind | null;
	readonly late_growth_markers: readonly LateGrowthMarkerOutput[];
}

export interface ArtifactOutput {
	readonly id: string;
	readonly kind: string;
	readonly title: string;
	readonly body: string;
	readonly created_at: string;
}

export type GraphSelectorOutput =
	| { readonly kind: "task"; readonly value: string }
	| { readonly kind: "scope"; readonly value: string }
	| { readonly kind: "all" };

export interface GraphNodeOutput extends TaskSummaryOutput {
	readonly claimable: boolean;
	readonly unresolved_dependency_ids: readonly string[];
	readonly supersedes_task_id: string | null;
	readonly superseded_by_task_id: string | null;
}

export type GraphEdgeOutput =
	| {
			readonly kind: "after";
			readonly from_task_id: string;
			readonly to_task_id: string;
			readonly satisfied: boolean;
	  }
	| {
			readonly kind: Extract<EdgeKind, "about" | "repair">;
			readonly from_task_id: string;
			readonly to_task_id: string;
	  }
	| {
			readonly kind: "gate";
			readonly from_task_id: string;
			readonly to_task_id: string;
			readonly state: GateState;
			readonly members: GateInspectOutput["members"];
	  }
	| {
			readonly kind: "supersedes";
			readonly from_task_id: string;
			readonly to_task_id: string;
	  };

export interface GraphInspectOutput {
	readonly ok: true;
	readonly graph: {
		readonly selector: GraphSelectorOutput;
		readonly nodes: readonly GraphNodeOutput[];
		readonly edges: readonly GraphEdgeOutput[];
		readonly late_growth_markers: readonly LateGrowthMarkerOutput[];
	};
}

export interface BlockerOutput {
	readonly id: string;
	readonly scope_id: string;
	readonly status: TaskStatus;
	readonly scope_description: string | null;
}

export interface BlockedTaskOutput extends TaskSummaryOutput {
	readonly unresolved_dependency_ids: readonly string[];
	readonly blockers: readonly BlockerOutput[];
	readonly gates: readonly GateInspectOutput[];
}

export interface BriefingOutput {
	readonly ok: true;
	readonly ready: readonly TaskSummaryOutput[];
	readonly blocked: readonly BlockedTaskOutput[];
	readonly recentlyCompleted: readonly TaskSummaryOutput[];
}

export interface ChainOutput {
	readonly policy: ChainPolicy;
	readonly applied: ChainPolicyDecision["applied"];
	readonly held_task_id: string | null;
	readonly source_task_id: string | null;
	readonly source_kind: SourceKind | null;
	readonly implicit_dependency_ids: readonly string[];
	readonly final_dependency_ids: readonly string[];
}

export interface EnqueueOutput {
	readonly ok: true;
	readonly task: { readonly id: string; readonly status: "queued" };
	readonly chain: ChainOutput;
}

export interface SupersedeOutput {
	readonly ok: true;
	readonly task: {
		readonly id: string;
		readonly status: "queued";
		readonly scope_id: string;
		readonly capability: Capability;
	};
	readonly supersession: {
		readonly old_task_id: string;
		readonly new_task_id: string;
		readonly retargeted_dependent_task_ids: readonly string[];
	};
}

export interface LaunchPreconditionEscalationOutput {
	readonly ok: true;
	readonly task: { readonly id: string; readonly status: "cancelled" };
	readonly escalation: {
		readonly id: string;
		readonly status: "queued";
		readonly scope_id: "global";
		readonly capability: "escalate";
		readonly source_task_id: string;
		readonly source_kind: "repair";
	};
}

export interface RepairAlertOutput {
	readonly ok: true;
	readonly escalation: {
		readonly id: string;
		readonly status: "queued";
		readonly scope_id: "global";
		readonly capability: "escalate";
		readonly source_task_id: string | null;
		readonly source_kind: "repair" | null;
		readonly kind: RepairAlertKind;
	};
}

export interface ScopeIdentityOutput {
	readonly id: string;
	readonly kind: ScopeKind;
	readonly canonical_path: string | null;
	readonly parent_repo_path: string | null;
	readonly archived_at: string | null;
	readonly description: string | null;
}

export interface ScopeOutput extends ScopeIdentityOutput {
	readonly task_count: number;
	readonly run_count: number;
}

export interface RunOutput {
	readonly id: string;
	readonly agent: string;
	readonly mode: Mode;
	readonly scope_id: string;
	readonly status: string;
	readonly task_id: string | null;
	readonly has_claimed_task: boolean;
	readonly session_id: string;
	readonly harness_kind: HarnessKind;
	readonly session_log_path: string;
	readonly created_at: string;
	readonly updated_at: string;
}

export interface EventOutput {
	readonly id: string;
	readonly type: string;
	readonly task_id: string | null;
	readonly run_id: string | null;
	readonly actor_run_id: string | null;
	readonly payload: Json;
	readonly created_at: string;
}
