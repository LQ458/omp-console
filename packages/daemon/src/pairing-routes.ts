import type { DeviceAuthStore, PairResult } from "./device-auth";

interface PairingRoutesOptions {
	store: DeviceAuthStore;
	isSecure: (req: Request) => boolean;
	onRevoked: (id: string) => void;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const PAIR_RATE_WINDOW_MS = 60_000;
const PAIR_RATE_MAX = 10;

function reply(status: number, body: unknown, headers?: Record<string, string>): Response {
	const merged = new Headers(JSON_HEADERS);
	if (headers) for (const [name, value] of Object.entries(headers)) merged.set(name, value);
	return new Response(JSON.stringify(body), { status, headers: merged });
}

function cookie(token: string, secure: boolean): string {
	return `omc_device=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000${secure ? "; Secure" : ""}`;
}

function clearCookie(secure: boolean): string {
	return `omc_device=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function createPairingRoutes(options: PairingRoutesOptions): (req: Request, url: URL, deviceId?: string) => Promise<Response | undefined> {
	const attempts: number[] = [];
	return async (req, url, deviceId) => {
		if (url.pathname === "/api/pair/status" && req.method === "GET") {
			return reply(200, { paired: deviceId !== undefined });
		}
		if (url.pathname === "/api/pair" && req.method === "POST") {
			const now = Date.now();
			while (attempts.length > 0 && attempts[0]! <= now - PAIR_RATE_WINDOW_MS) attempts.shift();
			if (attempts.length >= PAIR_RATE_MAX) {
				const retryAfter = Math.max(1, Math.ceil((attempts[0]! + PAIR_RATE_WINDOW_MS - now) / 1000));
				return reply(429, { code: "rate-limited", error: "Too many pairing attempts. Wait before trying again." }, { "retry-after": String(retryAfter) });
			}
			attempts.push(now);
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return reply(400, { code: "bad-request", error: "Pairing request must be JSON." });
			}
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				return reply(400, { code: "bad-request", error: "Pairing request must include a code and device label." });
			}
			const record = body as Record<string, unknown>;
			if (typeof record.code !== "string" || typeof record.label !== "string") {
				return reply(400, { code: "bad-request", error: "Pairing request must include a code and device label." });
			}
			let result: PairResult;
			try {
				result = await options.store.pair(record.code, record.label);
			} catch {
				return reply(500, { code: "internal", error: "Could not save this device." });
			}
			if (!result.ok) {
				if (result.reason === "unavailable" || result.reason === "expired") {
					return reply(410, { code: "expired", error: "This pairing code expired or was already used. Request a new code." });
				}
				if (result.reason === "invalid-label") {
					return reply(400, { code: "bad-request", error: "Device label must be 1–100 characters." });
				}
				return reply(400, { code: "wrong", error: "That pairing code is incorrect." });
			}
			return reply(200, { deviceId: result.device.id }, { "set-cookie": cookie(result.token, options.isSecure(req)) });
		}
		if (url.pathname === "/api/devices" && req.method === "GET") {
			if (!deviceId) return reply(401, { code: "unauthorized", error: "unauthorized" });
			return reply(200, { devices: options.store.list(), currentDeviceId: deviceId });
		}
		if (url.pathname === "/api/pair/code" && req.method === "POST") {
			if (!deviceId) return reply(401, { code: "unauthorized", error: "unauthorized" });
			try {
				return reply(200, await options.store.issuePairingCode());
			} catch {
				return reply(500, { code: "internal", error: "Could not issue a pairing code." });
			}
		}
		const match = /^\/api\/devices\/([^/]+)$/.exec(url.pathname);
		if (match && req.method === "DELETE") {
			if (!deviceId) return reply(401, { code: "unauthorized", error: "unauthorized" });
			let id: string;
			try {
				id = decodeURIComponent(match[1]!);
			} catch {
				return reply(400, { code: "bad-request", error: "Invalid device id." });
			}
			try {
				if (!(await options.store.remove(id))) return reply(404, { code: "not-found", error: "Device not found." });
			} catch {
				return reply(500, { code: "internal", error: "Could not revoke this device." });
			}
			options.onRevoked(id);
			const loggedOut = id === deviceId;
			const headers = loggedOut ? { "set-cookie": clearCookie(options.isSecure(req)) } : undefined;
			return reply(200, { revoked: id, loggedOut }, headers);
		}
		return undefined;
	};
}
