import type { SessionOp, SessionOpResult, SessionOpV3, SessionOpV3Result } from "@omp-console/protocol";

/** Route port for forwarding validated Wave 2 and Wave 3 session operations to the worker supervisor. */
export interface SessionOpsPorts {
	/** Runs one operation in the session's worker; a refusal rejects with an error carrying an `ApiError` `code`. */
	sessionOp(sessionId: string, op: SessionOp | SessionOpV3, signal?: AbortSignal): Promise<SessionOpResult | SessionOpV3Result>;
}
