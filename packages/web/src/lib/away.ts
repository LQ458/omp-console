/**
 * Away-mode actions for sessions the page is not showing.
 * Background turns are stopped through the daemon control API, without opening a guest connection.
 */
import { DeckApiError, type DeckApi } from "./api";

export type StopTurnResult = "aborted" | "idle" | "not-authorized" | "unavailable";

export async function stopTurn(api: DeckApi, sessionId: string): Promise<StopTurnResult> {
	try {
		await api.abortSession(sessionId);
		return "aborted";
	} catch (err) {
		if (!(err instanceof DeckApiError)) throw err;
		if (err.status === 409) return "idle";
		if (err.status === 401 || err.status === 403) return "not-authorized";
		if (err.status === 404 || err.kind === "network") return "unavailable";
		throw err;
	}
}
