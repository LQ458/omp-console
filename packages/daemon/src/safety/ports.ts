import type {
	CreateSessionRequest,
	HistoryEdge,
	KeyPoints,
	SessionSummary,
	WorkspaceKind,
} from "@omp-console/protocol";

export interface SafetyPorts {
	sessionCwd(id: string): string | undefined;
	/** The live session's model (`provider/id`), so the session that continues a moved project keeps it. */
	sessionModel(id: string): string | undefined;
	sessionWorkspaceKind(id: string): WorkspaceKind | undefined;
	abortSession(id: string): Promise<void>;
	freezeSession(id: string, frozen: boolean): Promise<void>;
	createSession(request: CreateSessionRequest & { idempotencyKey: string }): Promise<SessionSummary>;
	/** The first message of the session that continues a moved project (its handoff). */
	sendPrompt(id: string, text: string): Promise<void>;
	keyPoints(id: string): Promise<KeyPoints>;
	/**
	 * omp's handoff on a live, idle session: the document is committed as that session's compaction and returned.
	 * Rejects when the session has nothing to hand off, no model, or the model call fails; callers fall back to
	 * `keyPoints`.
	 */
	handoffDocument(id: string, focus: string): Promise<string>;
	recordEdge(edge: HistoryEdge): Promise<void> | void;
	/** Stop a live session if it is running (no-op otherwise); undo stops the copy's session before trashing it. */
	stopSession(id: string): Promise<void>;
	initializeGit(cwd: string): Promise<void>;
}
