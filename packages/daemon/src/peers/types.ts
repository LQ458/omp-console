export interface PeerDaemon {
	id: string;
	name: string;
	/** Base HTTP(S) URL of the peer daemon. */
	url: string;
	/** 0600 file containing a device token issued by the remote daemon. */
	tokenFile?: string;
	/** Loaded at daemon startup; never returned by peer APIs or logged. */
	token?: string;
}

const PEER_ID_RE = /^[a-z][a-z0-9-]{0,23}$/;

export function decodePeerId(raw: string): string | undefined {
	try {
		const decoded = decodeURIComponent(raw);
		return PEER_ID_RE.test(decoded) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

export function peerBaseUrl(peer: PeerDaemon): URL {
	const base = new URL(peer.url);
	if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("peer URL must use HTTP or HTTPS");
	if (base.username || base.password) throw new Error("peer URL must not contain credentials");
	base.pathname = "/";
	base.search = "";
	base.hash = "";
	return base;
}
