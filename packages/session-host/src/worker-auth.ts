let activeAuthorization: { origin: string; token: string } | undefined;
let installed = false;

function webOrigin(url: string | URL): string {
	const parsed = new URL(url);
	if (parsed.protocol === "ws:") parsed.protocol = "http:";
	else if (parsed.protocol === "wss:") parsed.protocol = "https:";
	return parsed.origin;
}

/** Adds the worker credential only to WebSocket handshakes targeting its daemon relay. */
export function installWorkerWebSocketAuth(relayUrl: string, token: string): void {
	activeAuthorization = { origin: webOrigin(relayUrl), token };
	if (installed) return;
	const nativeWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = new Proxy(nativeWebSocket, {
		construct(target, args, newTarget) {
			const [url, options] = args as unknown as [string | URL, Bun.WebSocketOptions?];
			const authorization = activeAuthorization;
			if (authorization === undefined || webOrigin(url) !== authorization.origin || (options !== undefined && typeof options !== "object") || Array.isArray(options)) {
				return Reflect.construct(target, args, newTarget) as WebSocket;
			}
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(options?.headers ?? {})) {
				if (value === undefined || name.toLowerCase() === "authorization") continue;
				headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
			}
			headers.authorization = `Bearer ${authorization.token}`;
			return Reflect.construct(target, [url, { ...options, headers }], newTarget) as WebSocket;
		},
	});
	installed = true;
}
