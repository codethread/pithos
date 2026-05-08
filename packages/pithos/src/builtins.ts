export const BUILTIN_AGENT_KINDS = ["pdx", "pandora", "toil", "greed", "war"] as const;
export const BUILTIN_CAPABILITIES = ["triage", "design", "execute", "escalate"] as const;

export type AgentKind = (typeof BUILTIN_AGENT_KINDS)[number];
export type Capability = (typeof BUILTIN_CAPABILITIES)[number];

export const BUILTIN_AGENT_CLAIMS = {
	pandora: ["escalate"],
	toil: ["triage"],
	greed: ["design"],
	war: ["execute"],
} as const satisfies Partial<Record<AgentKind, readonly Capability[]>>;

export const BUILTIN_AGENT_ENQUEUES = {
	pdx: ["escalate"],
	pandora: ["triage", "design", "escalate"],
	toil: ["triage", "design", "execute", "escalate"],
	greed: ["triage", "design", "escalate"],
	war: ["escalate"],
} as const satisfies Record<AgentKind, readonly Capability[]>;

export const BUILTIN_CONTRACT = {
	agentKinds: BUILTIN_AGENT_KINDS,
	capabilities: BUILTIN_CAPABILITIES,
	claims: BUILTIN_AGENT_CLAIMS,
	enqueues: BUILTIN_AGENT_ENQUEUES,
} as const;
