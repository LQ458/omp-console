/**
 * Location-hash deep links.
 *
 * - `#session=<sessionId>`: select that daemon session (used by push notification clicks).
 * - `#new=<urlencoded path>`: open the new-session picker at that path (`omp-console://new?cwd=` from the Mac app); the
 *   session sidebar consumes it.
- anything else after the first `#`: a collab link (`<roomId>.<key>` or a relay URL); foreign relays require confirmation.
 */

import { parseCollabLink } from "./link";

const SESSION_ID_PATTERN = /^(?:[a-z][a-z0-9-]{0,23}:)?[A-Za-z0-9_-]{1,128}$/;
const MAX_NEW_PATH_LENGTH = 1024;

export type DeepLink =
	| { kind: "session"; sessionId: string }
	| { kind: "new"; cwd: string }
	| { kind: "room"; link: string };


/** `hash` is `location.hash` (with or without the leading `#`). */
export function parseDeepLink(hash: string): DeepLink | null {
	const body = hash.startsWith("#") ? hash.slice(1) : hash;
	if (body === "") return null;
	if (body.startsWith("session=")) {
		const sessionId = new URLSearchParams(body).get("session")?.trim();
		return sessionId && SESSION_ID_PATTERN.test(sessionId) ? { kind: "session", sessionId } : null;
	}
	if (body.startsWith("new=")) {
		const cwd = new URLSearchParams(body).get("new")?.trim();
		return cwd && cwd.length <= MAX_NEW_PATH_LENGTH ? { kind: "new", cwd } : null;
	}
	if (body.startsWith("pair=")) return null;
	return { kind: "room", link: body };

}

export interface PairFragmentTarget {
	location: { readonly hash: string; readonly pathname: string; readonly search: string };
	history: {
		readonly state: unknown;
		replaceState(data: unknown, unused: string, url?: string | URL | null): void;
	};
}

/** Consumes the one-time pair code before the app mounts; the fragment never reaches the daemon. */
export function consumePairFragment(target: PairFragmentTarget): string | null {
	const body = target.location.hash.startsWith("#") ? target.location.hash.slice(1) : target.location.hash;
	if (!body.startsWith("pair=")) return null;
	const code = new URLSearchParams(body).get("pair") ?? "";
	target.history.replaceState(target.history.state, "", `${target.location.pathname}${target.location.search}`);
	return code;
}


/** Returns the host of a relay that needs confirmation, or null for a same-origin relay/peer bridge. */
export function foreignRelayHost(link: string, pageOrigin: string): string | null {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) return null;
	const relay = new URL(parsed.wsUrl);
	const page = new URL(pageOrigin);
	const expectedRelayProtocol = page.protocol === "https:" ? "wss:" : page.protocol === "http:" ? "ws:" : null;
	return relay.protocol === expectedRelayProtocol && relay.host === page.host ? null : relay.host;
}

/** The slice of `window` the watcher needs. */
export interface HashTarget {
	readonly location: { readonly hash: string };
	addEventListener(type: "hashchange", listener: () => void): void;
	removeEventListener(type: "hashchange", listener: () => void): void;
}

/**
 * Selects the session named by `#session=<id>` now and on every hash change. The hash is cleared
 * after it is handled (`clearHash`), so the same notification tapped again changes the hash again
 * and fires again. Room-link hashes are left to the caller. Returns the unsubscribe function.
 */
export function watchSessionDeepLink(
	target: HashTarget,
	onSession: (sessionId: string) => void,
	clearHash: () => void,
): () => void {
	const handle = (): void => {
		const link = parseDeepLink(target.location.hash);
		if (link?.kind !== "session") return;
		clearHash();
		onSession(link.sessionId);
	};
	target.addEventListener("hashchange", handle);
	handle();
	return () => target.removeEventListener("hashchange", handle);
}
