import type { PeerInfo, PeersResponse } from "@omp-console/protocol";
import { errorResponse, json } from "../api";
import { decodePeerId, peerBaseUrl, type PeerDaemon } from "./types";

export type PeerFetch = (input: URL, init?: RequestInit) => Promise<Response>;

export interface PeerRoutesOptions {
	self: { id: string; name: string };
	peers: readonly PeerDaemon[];
	fetch?: PeerFetch;
	/** Peer health-check timeout; defaults to 3 seconds. */
	timeoutMs?: number;
	log: (message: string) => void;
}

const HEALTH_CACHE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "if-none-match"] as const;
const PEER_PROXY_ROUTE = /^\/api\/peers\/([^/]+)\/(.+)$/;

interface HealthEntry {
	expiresAt: number;
	result: PeerInfo | undefined;
	pending: Promise<PeerInfo> | undefined;
}


function isNestedPeerPath(rest: string): boolean {
	if (rest === "peers" || rest.startsWith("peers/")) return true;
	const slash = rest.indexOf("/");
	const firstSegment = rest.slice(0, slash === -1 ? rest.length : slash);
	try {
		const decoded = decodeURIComponent(firstSegment);
		return decoded === "peers" || decoded.startsWith("peers/");
	} catch {
		return false;
	}
}

function safeRequestHeaders(req: Request): Headers {
	const headers = new Headers();
	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = req.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	return headers;
}
function peerAuthorization(peer: PeerDaemon): string {
	if (!peer.token) throw new Error("peer device token is missing");
	return `Bearer ${peer.token}`;
}

function responseHeaders(response: Response): Headers {
	const headers = new Headers();
	const contentType = response.headers.get("content-type");
	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType === "application/json" || mediaType === "text/event-stream") {
		if (contentType !== null && contentType !== undefined) headers.set("content-type", contentType);
	} else {
		headers.set("content-type", "application/octet-stream");
		headers.set("content-disposition", "attachment");
	}
	return headers;
}

export function createPeerRoutes(
	options: PeerRoutesOptions,
): (req: Request, url: URL) => Promise<Response | undefined> {
	const fetcher = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const peersById = new Map(options.peers.map(peer => [peer.id, peer]));
	const healthCache = new Map<string, HealthEntry>();

	async function health(peer: PeerDaemon): Promise<PeerInfo> {
		const now = Date.now();
		const cached = healthCache.get(peer.id);
		if (cached?.result && cached.expiresAt > now) return cached.result;
		if (cached?.pending) return cached.pending;

		const entry: HealthEntry = { expiresAt: 0, result: undefined, pending: undefined };
		healthCache.set(peer.id, entry);
		entry.pending = (async (): Promise<PeerInfo> => {
			let reachable = false;
			let reason: string | undefined;
			let signal: AbortSignal | undefined;
			try {
				signal = AbortSignal.timeout(timeoutMs);
				const target = new URL("/api/health", peerBaseUrl(peer));
				const response = await fetcher(target, { method: "GET", headers: { authorization: peerAuthorization(peer) }, signal });
				reachable = response.ok;
				if (!reachable) reason = `health check returned HTTP ${response.status}`;
				if (response.body) {
					try {
						await response.body.cancel();
					} catch {
						// The status is sufficient; a health response body is never consumed.
					}
				}
			} catch {
				reason = signal?.aborted ? "health check timed out" : "health check failed";
				options.log(`peer ${peer.id} health check failed`);
			}

			const result: PeerInfo = reachable
				? { id: peer.id, name: peer.name, reachable: true }
				: { id: peer.id, name: peer.name, reachable: false, reason: reason ?? "health check failed" };
			entry.result = result;
			entry.expiresAt = Date.now() + HEALTH_CACHE_MS;
			entry.pending = undefined;
			return result;
		})();
		return entry.pending;
	}

	return async (req, url) => {
		if (url.pathname === "/api/peers") {
			if (req.method !== "GET") {
				return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "GET" });
			}
			const peers = await Promise.all(options.peers.map(peer => health(peer)));
			const body: PeersResponse = { self: options.self, peers };
			return json(200, body);
		}

		const match = PEER_PROXY_ROUTE.exec(url.pathname);
		if (!match) return undefined;
		const peerId = decodePeerId(match[1]!);
		if (!peerId) return errorResponse(400, "bad-request", "invalid peer id");
		const rest = match[2]!;
		const peer = peersById.get(peerId);
		if (!peer) return errorResponse(404, "not-found", `unknown peer ${JSON.stringify(peerId)}`);
		if (isNestedPeerPath(rest)) {
			return errorResponse(400, "bad-request", "nested peer proxy paths are not allowed");
		}

		try {
			const target = new URL(`/api/${rest}`, peerBaseUrl(peer));
			target.search = url.search;
			const headers = safeRequestHeaders(req);
			headers.set("authorization", peerAuthorization(peer));
			const init: RequestInit & { duplex?: "half" } = {
				method: req.method,
				headers,
				signal: req.signal,
				...(req.body === null ? {} : { body: req.body, duplex: "half" }),
			};
			const upstream = await fetcher(target, init);
			return new Response(upstream.body, {
				status: upstream.status,
				statusText: upstream.statusText,
				headers: responseHeaders(upstream),
			});
		} catch (error) {
			const errorName = error instanceof Error ? error.name : "unknown error";
			options.log(`peer ${peer.id} request failed: ${errorName}`);
			return errorResponse(502, "internal", `peer ${JSON.stringify(peer.name)} is unreachable`);
		}
	};
}
