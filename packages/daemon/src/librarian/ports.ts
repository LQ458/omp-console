import type { AgendaItem, SessionSummary } from "@omp-console/protocol";
import type { PersistedSession } from "../history/ports";
import type { DecisionModel, TextModel } from "../models/types";

export interface ConversationMessage {
	role: "user" | "assistant";
	text: string;
}

/** Bounded transcript view supplied by the live worker; session files remain read-only. */
export interface LiveConversation {
	messages: ConversationMessage[];
	firstUserPrompt?: string;
}

export interface LibrarianPorts {
	/** Current live sessions. */
	list(): SessionSummary[];
	/** The same SessionManager lister used by the history area. */
	listPersisted(): Promise<PersistedSession[]>;
	/** Recent transcript messages from a live worker, plus the first user prompt for schedule matching. */
	readLiveConversation(sessionId: string): Promise<LiveConversation>;
	textModel: TextModel;
	decisionModel: DecisionModel;
	/** Today's tasks-hub agenda. Omit when that area is unavailable. */
	agendaToday?: () => Promise<AgendaItem[]>;
}
