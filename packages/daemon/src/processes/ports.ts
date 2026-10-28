import type { SessionSummary, WorkerHealth } from "@omp-console/protocol";

export interface ProcessPorts {
	liveSessions(): SessionSummary[];
	workerHealth(): Promise<WorkerHealth[]>;
	stopSession(sessionId: string): Promise<boolean>;
}
