import type { SessionSummary } from "@omp-console/protocol";

const KEY = "omp-console-last-session";

export function rememberLastSession(storage: Pick<Storage, "setItem">, sessionId: string): void {
	try {
		storage.setItem(KEY, sessionId);
	} catch {
		// Storage is blocked (private mode): the open session just is not restored on the next launch.
	}
}

export function readLastSession(storage: Pick<Storage, "getItem">): string | null {
	try {
		return storage.getItem(KEY);
	} catch {
		return null;
	}
}

export function forgetLastSession(storage: Pick<Storage, "removeItem">): void {
	try {
		storage.removeItem(KEY);
	} catch {
		// nothing to forget
	}
}

/**
 * The session to reopen after a reload or relaunch: the one that was open, if it is still live. A deep link in the
 * address bar (`#session=...` from a notification tap, or a joined room link) and an existing selection always win.
 */
export function pickRestorableSession(
	stored: string | null,
	live: readonly SessionSummary[],
	hash: string,
	selectedId: string | null,
): string | null {
	if (selectedId !== null || hash.length > 1 || stored === null) return null;
	return live.some(session => session.id === stored) ? stored : null;
}
