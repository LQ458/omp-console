import type { SpawnAgentRequest, WorkerStatus } from "@omp-console/protocol";

export type PlanAgentEvent = Extract<WorkerStatus, { t: "agent" }>;

export interface PlanPorts {
	spawn(sessionId: string, request: SpawnAgentRequest): Promise<{ agentId: string }>;
	cancelAgent(sessionId: string, agentId: string): Promise<void>;
	onAgentEvent(listener: (sessionId: string, event: PlanAgentEvent) => void): () => void;
	knownProfiles(sessionId: string): Promise<string[]>;
	now(): number;
}
