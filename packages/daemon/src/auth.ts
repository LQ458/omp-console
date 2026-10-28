/**
 * Request guard: who may talk to the daemon, and from which web origin.
 *
 * Threat model: the daemon binds 127.0.0.1, but a web page can still reach it by DNS rebinding or cross-site requests.
 * Loopback is not an identity. Every request (every route and method, WebSocket upgrades, and static files) must pass:
 *
 *  1. the peer is loopback;
 *  2. `Host` and every `X-Forwarded-Host` entry are on the allowlist (port ignored), or the request is refused with 421;
 *  3. a request carrying `Origin` has an origin whose host is allowlisted and equals the effective host including port,
 *     or it is refused with 403. Requests without Origin pass this check;
 *  4. if `Tailscale-User-Login` is present, it matches `--owner`; proxy headers without that matching login are refused.
 *     This header can only narrow access; it never authenticates a request by itself.
 *
 * The server separately requires a paired-device token for protected API, WebSocket and peer-proxy routes. Static
 * assets stay public so the Pair screen can load. Same-OS-user code, including the agent, is outside this boundary.
 *
 * Browsers cannot forge `Host` or `Origin`; cross-origin requests cannot pass preflight because the daemon sends no
 * CORS headers.
 */

export const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";

/** Always allowed; `--allow-host` adds to this list (for example the machine's `*.ts.net` name). */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via"];
const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?::(\d{1,5}))?$/i;
const ORIGIN_RE = /^https?:\/\/[^/?#@\s]+$/i;

export interface AuthConfig {
	/** Expected Tailscale login; if its header is present it must match and never grants access by itself. */
	owner?: string;
	/** Lowercase hostnames (no port) from `normalizeAllowedHosts`. */
	allowedHosts: ReadonlySet<string>;
}

export interface Denial {
	status: 401 | 403 | 421;
	message: string;
}

interface HostPort {
	/** Lowercase, IPv6 in brackets. */
	hostname: string;
	port: number | undefined;
}

export function isLoopbackAddress(address: string | undefined): boolean {
	if (!address) return false;
	const addr = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
	return addr === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

/** `host[:port]` as found in `Host` / `X-Forwarded-Host`; `null` when malformed (userinfo, path, spaces, ...). */
export function parseHostPort(value: string): HostPort | null {
	const match = HOST_RE.exec(value.trim());
	if (!match) return null;
	const port = match[2] === undefined ? undefined : Number(match[2]);
	if (port !== undefined && port > 65_535) return null;
	return { hostname: match[1]!.toLowerCase(), port };
}

/**
 * Validates `--allow-host` values (`name` or `name:port`; the port is ignored) and merges them with the defaults.
 * Throws on anything that is not a plain host name, including wildcards.
 */
export function normalizeAllowedHosts(extra: readonly string[] = []): Set<string> {
	const hosts = new Set(DEFAULT_ALLOWED_HOSTS);
	for (const entry of extra) {
		const parsed = parseHostPort(entry);
		if (!parsed) {
			throw new Error(`invalid allowed host "${entry}" (use a plain host name such as host.tailnet-example.ts.net; IPv6 needs brackets; no wildcards)`);
		}
		hosts.add(parsed.hostname);
	}
	return hosts;
}

function defaultPort(scheme: string): number {
	return scheme === "https" ? 443 : 80;
}

function originMatches(origin: string, effective: HostPort, effectiveScheme: string, allowed: ReadonlySet<string>): boolean {
	if (!ORIGIN_RE.test(origin)) return false; // includes the literal "null" origin of sandboxed frames
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	const hostname = url.hostname.toLowerCase();
	if (!allowed.has(hostname)) return false;
	const originScheme = url.protocol.slice(0, -1);
	const originPort = url.port === "" ? defaultPort(originScheme) : Number(url.port);
	const effectivePort = effective.port ?? defaultPort(effectiveScheme);
	return hostname === effective.hostname && originPort === effectivePort;
}

function hasProxyHeaders(headers: Headers): boolean {
	for (const name of PROXY_HEADERS) if (headers.has(name)) return true;
	for (const [name] of headers) if (name.startsWith("tailscale-")) return true;
	return false;
}

/** `null` when the request may proceed, otherwise the response to send. */
export function checkRequest(headers: Headers, remoteAddress: string | undefined, config: AuthConfig): Denial | null {
	if (!isLoopbackAddress(remoteAddress)) return { status: 401, message: "unauthorized" };

	const host = parseHostPort(headers.get("host") ?? "");
	if (!host || !config.allowedHosts.has(host.hostname)) return { status: 421, message: "host not allowed" };

	let effective = host;
	const forwardedHost = headers.get("x-forwarded-host");
	if (forwardedHost !== null) {
		const entries = forwardedHost.split(",").map(entry => parseHostPort(entry));
		for (const entry of entries) {
			if (!entry || !config.allowedHosts.has(entry.hostname)) return { status: 421, message: "forwarded host not allowed" };
		}
		effective = entries[0]!;
	}

	const origin = headers.get("origin");
	if (origin !== null) {
		const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
		if (!originMatches(origin, effective, proto === "https" ? "https" : "http", config.allowedHosts)) {
			return { status: 403, message: "origin not allowed" };
		}
	}

	const login = headers.get(TAILSCALE_LOGIN_HEADER);
	if (login !== null) {
		const { owner } = config;
		const matchesOwner = owner !== undefined && owner !== "" && login.trim().toLowerCase() === owner.trim().toLowerCase();
		if (!matchesOwner) return { status: 401, message: "unauthorized" };
	}
	if (hasProxyHeaders(headers) && login === null) return { status: 401, message: "unauthorized" };
	return null;
}

/** Refuses browser-marked cross-site and same-site requests to API and relay routes. */
export function checkFetchSite(headers: Headers, pathname: string): Denial | null {
	const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
	if (site !== "cross-site" && site !== "same-site") return null;
	const isApi = pathname === "/api" || pathname.startsWith("/api/");
	const isRelayUpgrade = headers.get("upgrade")?.trim().toLowerCase() === "websocket" &&
		(pathname.startsWith("/r/") || pathname.startsWith("/live/") || /^\/peers\/[^/]+\/r(?:\/|$)/.test(pathname));
	return isApi || isRelayUpgrade ? { status: 403, message: "fetch site not allowed" } : null;
}
