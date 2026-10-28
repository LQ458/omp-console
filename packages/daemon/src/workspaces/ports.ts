import type { CreateSessionRequest, SessionSummary } from "@omp-console/protocol";
import type { HistoryEdge, KeyPoints } from "@omp-console/protocol";

export interface QuickAskSessionRequest {
	cwd: string;
	resumeSessionFile?: string;
	title: "quick-ask";
	profile: "kb";
	hidden: true;
}
export interface WorkspacePorts {
	createSession(request: CreateSessionRequest): Promise<SessionSummary>;
	createQuickAskSession(request: QuickAskSessionRequest): Promise<SessionSummary>;
	sendPrompt(sessionId: string, text: string): Promise<void>;
	keyPoints(sessionId: string): Promise<KeyPoints | undefined>;
	/** omp's handoff on a live session (compacts it, returns the document); see `SafetyPorts.handoffDocument`. */
	handoffDocument(sessionId: string, focus: string): Promise<string>;
	liveSessions(): SessionSummary[];
	recordEdge(edge: HistoryEdge): void | Promise<void>;
}
