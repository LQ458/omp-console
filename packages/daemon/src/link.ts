/**
 * Room link for the web client. Format matches `packages/collab-web/src/lib/link.ts` (`parseCollabLink`):
 * `<web origin>/#<compact collab link>`, where the compact collab link is
 * `host[:port]/r/<roomId>.<key>` for wss relays and the full `ws://127.0.0.1:port/r/...` for loopback.
 * `<key>` is base64url(key) for view links and base64url(key ∥ writeToken) for full links.
 */
import type { RoomSecrets } from "./supervisor";

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostnameOf(host: string): string {
	if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
	const colon = host.lastIndexOf(":");
	return colon === -1 ? host : host.slice(0, colon);
}

export interface Origin {
	/** `http` or `https` */
	scheme: "http" | "https";
	/** hostname[:port] */
	host: string;
}

/**
 * Origin the client reached the daemon through. `tailscale serve` forwards the public host and `https`;
 * a direct loopback request keeps its Host header. Falls back to `fallbackHost` for a missing or malformed host.
 */
export function originFromRequest(headers: Headers, fallbackHost: string): Origin {
	const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
	const candidate = forwardedHost || headers.get("host")?.trim() || fallbackHost;
	const host = HOST_RE.test(candidate) ? candidate : fallbackHost;
	const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
	const local = LOCAL_HOSTNAMES.has(hostnameOf(host).toLowerCase());
	// Plain ws is only valid for localhost; any other host must be reached over TLS.
	const scheme = local && proto !== "https" ? "http" : "https";
	return { scheme, host };
}

export function formatRoomLink(origin: Origin, secrets: RoomSecrets, permission: "full" | "view"): string {
	const secret = new Uint8Array(secrets.key.byteLength + (permission === "full" ? secrets.writeToken.byteLength : 0));
	secret.set(secrets.key, 0);
	if (permission === "full") secret.set(secrets.writeToken, secrets.key.byteLength);
	const keyText = Buffer.from(secret).toString("base64url");
	const collab =
		origin.scheme === "https"
			? `${origin.host}/r/${secrets.roomId}.${keyText}`
			: `ws://${origin.host}/r/${secrets.roomId}.${keyText}`;
	return `${origin.scheme}://${origin.host}/#${collab}`;
}
