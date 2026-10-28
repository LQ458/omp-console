/** A user or assistant message read from a saved session file without starting its agent. */
export interface SessionTranscriptMessage {
	role: "user" | "assistant";
	text: string;
}

/** `GET /api/sessions/:id/transcript` → a bounded, read-only view of a saved transcript. */
export interface SessionTranscriptResponse {
	messages: SessionTranscriptMessage[];
	/** True when only the newest 10 MiB of a larger session file was read. */
	truncated: boolean;
}
