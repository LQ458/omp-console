import type { KeyPoints, SessionSummary } from "@omp-console/protocol";

/** What the history area needs from the worker supervisor (its `list` and `summarize` methods have exactly these shapes). */
export interface HistoryPorts {
	/** Live sessions, newest state included. */
	list(): SessionSummary[];
	/** Key points of a live session from its worker; rejects with an error carrying an `ApiError` `code`. */
	summarize(sessionId: string): Promise<KeyPoints>;
}

/** One session omp persisted, as the history graph needs it. */
export interface PersistedSession {
	id: string;
	file: string;
	cwd: string;
	title?: string;
	/** `parentSession` of the session header: the id or the file of the session this one was forked or branched from. */
	parentSession?: string;
	createdAt: number;
	modifiedAt: number;
	firstMessage?: string;
}
