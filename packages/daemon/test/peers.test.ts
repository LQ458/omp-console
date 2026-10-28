import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import type { ApiError, PeersResponse } from "@omp-console/protocol";
import { createPeerRoutes, peerRelayUpgrade, peerRelayWebSocket, type PeerDaemon } from "../src/peers";
import { type LocalRelay, type RelaySocketData, startLocalRelay } from "../src/relay";
import { closeAllSockets, socket, until, waitBinary, waitEvent, waitOpen, waitText } from "./ws-helpers";
import { makeTmp } from "./helpers";
import { rawHttpRequest, startTestDaemon, stopTestDaemons } from "./harness";

const self = { id: "mac", name: "Mac" };
const peerToken = Buffer.alloc(32, 42).toString("base64url");
const peer: PeerDaemon = { id: "vps", name: "VPS", url: "https://vps.example", token: peerToken };

let httpPeerServer: Bun.Server<undefined> | undefined;
let websocketPeerServer: Bun.Server<{ connected: true }> | undefined;
let proxyServer: Bun.Server<RelaySocketData> | undefined;

afterEach(async () => {
	closeAllSockets();
	await stopTestDaemons();
	await proxyServer?.stop(true);
	await websocketPeerServer?.stop(true);
	await httpPeerServer?.stop(true);
	proxyServer = undefined;
	websocketPeerServer = undefined;
	httpPeerServer = undefined;
});

function requireResponse(response: Response | undefined): Response {
	if (!response) throw new Error("peer route did not handle the request");
	return response;
}

async function callRoute(
	handler: (req: Request, url: URL) => Promise<Response | undefined>,
	request: Request,
): Promise<Response | undefined> {
	return handler(request, new URL(request.url));
}

function routeRequest(path: string, init?: RequestInit): Request {
	return new Request(`http://daemon${path}`, init);
}

describe("peer daemon HTTP routes", () => {
	it("returns peer reachability and reuses the health result during its cache window", async () => {
		let calls = 0;
		const handler = createPeerRoutes({
			self,
			peers: [peer],
			fetch: async input => {
				calls++;
				expect(new URL(String(input)).href).toBe("https://vps.example/api/health");
				return new Response(null, { status: 200 });
			},
			log: () => {},
		});

		const first = requireResponse(await callRoute(handler, routeRequest("/api/peers")));
		const second = requireResponse(await callRoute(handler, routeRequest("/api/peers")));
		expect(first.status).toBe(200);
		expect((await first.json()) as PeersResponse).toEqual({
			self,
			peers: [{ id: "vps", name: "VPS", reachable: true }],
		});
		expect((await second.json()) as PeersResponse).toEqual({
			self,
			peers: [{ id: "vps", name: "VPS", reachable: true }],
		});
		expect(calls).toBe(1);
	});

	it("marks a peer unreachable when its health check times out and caches that result", async () => {
		let calls = 0;
		const handler = createPeerRoutes({
			self,
			peers: [peer],
			timeoutMs: 5,
			fetch: (_input, init) => {
				calls++;
				return new Promise<Response>((_, reject) => {
					const signal = init?.signal;
					if (!signal) {
						reject(new Error("missing timeout signal"));
						return;
					}
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
			log: () => {},
		});

		const first = requireResponse(await callRoute(handler, routeRequest("/api/peers")));
		const second = requireResponse(await callRoute(handler, routeRequest("/api/peers")));
		const result = (await first.json()) as PeersResponse;
		expect(result.peers).toEqual([{ id: "vps", name: "VPS", reachable: false, reason: "health check timed out" }]);
		expect((await second.json()) as PeersResponse).toEqual(result);
		expect(calls).toBe(1);
	});

	it("forwards method, path, query, body, and only safe request headers", async () => {
		let forwardedUrl = "";
		let forwardedInit: RequestInit | undefined;
		let forwardedBody = "";
		const handler = createPeerRoutes({
			self,
			peers: [{ ...peer, url: "https://vps.example/base" }],
			fetch: async (input, init) => {
				forwardedUrl = new URL(String(input)).href;
				forwardedInit = init;
				forwardedBody = await new Response(init?.body ?? null).text();
				return new Response("upstream response", {
					status: 207,
					statusText: "Multi-Status",
					headers: {
						"content-type": "text/plain; charset=utf-8",
						"set-cookie": "session=private",
						"access-control-allow-origin": "*",
					},
				});
			},
			log: () => {},
		});
		const request = routeRequest("/api/peers/vps/sessions/42?limit=2&order=oldest", {
			method: "PATCH",
			body: "payload",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				"if-none-match": '"etag-1"',
				cookie: "private-cookie",
				origin: "https://attacker.example",
				host: "attacker.example",
				"x-forwarded-for": "192.0.2.1",
			},
		});

		const response = requireResponse(await callRoute(handler, request));
		expect(forwardedUrl).toBe("https://vps.example/api/sessions/42?limit=2&order=oldest");
		expect(forwardedInit?.method).toBe("PATCH");
		const requestHeaders = new Headers(forwardedInit?.headers);
		expect([...requestHeaders.keys()].sort()).toEqual(["accept", "authorization", "content-type", "if-none-match"]);
		expect(requestHeaders.get("authorization")).toBe(`Bearer ${peerToken}`);
		expect(requestHeaders.get("accept")).toBe("application/json");
		expect(requestHeaders.get("content-type")).toBe("application/json");
		expect(requestHeaders.get("if-none-match")).toBe('"etag-1"');
		expect(forwardedBody).toBe("payload");
		expect(response.status).toBe(207);
		expect(response.statusText).toBe("Multi-Status");
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
		expect(response.headers.get("content-disposition")).toBe("attachment");
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(await response.text()).toBe("upstream response");
	});

	it("returns structured 404, 400, and 502 errors for unknown, nested, and unreachable peers", async () => {
		const logs: string[] = [];
		const handler = createPeerRoutes({
			self,
			peers: [peer],
			fetch: async () => {
				throw new Error("transport details must not leak");
			},
			log: message => logs.push(message),
		});

		const unknown = requireResponse(await callRoute(handler, routeRequest("/api/peers/missing/sessions")));
		const nested = requireResponse(await callRoute(handler, routeRequest("/api/peers/vps/peers/other/sessions")));
		const encodedNested = requireResponse(
			await callRoute(handler, routeRequest("/api/peers/vps/peers%2Fother/sessions")),
		);
		const unreachable = requireResponse(await callRoute(handler, routeRequest("/api/peers/vps/sessions")));
		expect(unknown.status).toBe(404);
		expect((await unknown.json()) as ApiError).toEqual({ error: 'unknown peer "missing"', code: "not-found" });
		expect(nested.status).toBe(400);
		expect((await nested.json()) as ApiError).toEqual({
			error: "nested peer proxy paths are not allowed",
			code: "bad-request",
		});
		expect(encodedNested.status).toBe(400);
		expect((await encodedNested.json()) as ApiError).toEqual({
			error: "nested peer proxy paths are not allowed",
			code: "bad-request",
		});
		expect(unreachable.status).toBe(502);
		expect((await unreachable.json()) as ApiError).toEqual({ error: 'peer "VPS" is unreachable', code: "internal" });
		expect(logs).toEqual(["peer vps request failed: Error"]);
	});

	it("streams a real loopback peer response through the HTTP route with peer bearer authentication", async () => {
		const authorizations: Array<string | null> = [];
		httpPeerServer = Bun.serve<undefined>({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				authorizations.push(req.headers.get("authorization"));
				const url = new URL(req.url);
				if (url.pathname === "/api/health") return new Response(null, { status: 200 });
				const body = await req.text();
				return new Response(`${req.method} ${url.pathname}${url.search} ${body}`, {
					status: 202,
					headers: { "content-type": "text/plain" },
				});
			},
		});
		const handler = createPeerRoutes({
			self,
			peers: [{ ...peer, url: `http://127.0.0.1:${httpPeerServer.port}` }],
			log: () => {},
		});
		const response = requireResponse(
			await callRoute(handler, routeRequest("/api/peers/vps/echo?q=1", { method: "POST", body: "smoke" })),
		);

		expect(response.status).toBe(202);
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
		expect(response.headers.get("content-disposition")).toBe("attachment");
		expect(await response.text()).toBe("POST /api/echo?q=1 smoke");
		expect(authorizations).toEqual([`Bearer ${peerToken}`]);
	});

	it("loads peer bearer credentials only from a 0600 token file", async () => {
		const authorizations: Array<string | null> = [];
		httpPeerServer = Bun.serve<undefined>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				authorizations.push(req.headers.get("authorization"));
				return Response.json({ ok: true });
			},
		});
		const tokenFile = path.join(makeTmp("omp-console-peer-token-"), "remote-token");
		fs.writeFileSync(tokenFile, `${peerToken}\n`, { mode: 0o600 });
		const t = await startTestDaemon({
			features: { librarian: false, agenda: false, quickAsk: false, peers: true, openrouterDecisions: false, computerUse: false, overnight: false },
			peers: [{ id: peer.id, name: peer.name, url: `http://127.0.0.1:${httpPeerServer.port}`, tokenFile }],
		});

		const response = await t.get("/api/peers/vps/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(authorizations).toEqual([`Bearer ${peerToken}`]);
	});
});

describe("peer daemon WebSocket bridge", () => {
	it("relays text and binary frames both ways, authenticates upstream, and propagates close codes and reasons", async () => {
		const peerPaths: string[] = [];
		const peerAuthorizations: Array<string | null> = [];
		const peerCloses: Array<{ code: number; reason: string }> = [];
		websocketPeerServer = Bun.serve<{ connected: true }>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req, server) {
				const url = new URL(req.url);
				peerPaths.push(`${url.pathname}${url.search}`);
				peerAuthorizations.push(req.headers.get("authorization"));
				if (server.upgrade(req, { data: { connected: true } })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.send("peer greeting");
					socket.send(new Uint8Array([9, 8]));
				},
				message(socket, message) {
					if (typeof message === "string" && message === "close-from-peer") {
						socket.close(4007, "peer close");
						return;
					}
					if (typeof message === "string" && message === "terminate-from-peer") {
						socket.terminate();
						return;
					}
					socket.send(typeof message === "string" ? `echo:${message}` : message);
				},
				close(_socket, code, reason) {
					peerCloses.push({ code, reason });
				},
			},
		});
		const peerConfig: PeerDaemon = { ...peer, url: `http://127.0.0.1:${websocketPeerServer.port}` };
		proxyServer = Bun.serve<RelaySocketData>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req, server) {
				const response = peerRelayUpgrade(req, server, [peerConfig]);
				return response === null ? new Response("not found", { status: 404 }) : response;
			},
			websocket: peerRelayWebSocket({ message() {} }),
		});

		const client = socket(`ws://127.0.0.1:${proxyServer.port}`, "/peers/vps/r/session-a?role=guest");
		await waitOpen(client);
		expect(await waitText(client, "peer text frame")).toBe("peer greeting");
		expect([...(await waitBinary(client, "peer binary frame"))]).toEqual([9, 8]);
		client.send("client text");
		expect(await waitText(client, "text frame to peer")).toBe("echo:client text");
		client.send(new Uint8Array([1, 2, 3]));
		expect([...(await waitBinary(client, "binary frame to peer"))]).toEqual([1, 2, 3]);
		expect(peerPaths).toContain("/r/session-a?role=guest");
		expect(peerAuthorizations[0]).toBe(`Bearer ${peerToken}`);

		const remoteClose = waitEvent<CloseEvent>(client, "close", "peer close propagation");
		client.send("close-from-peer");
		const remoteCloseEvent = await remoteClose;
		expect({ code: remoteCloseEvent.code, reason: remoteCloseEvent.reason }).toEqual({
			code: 4007,
			reason: "peer close",
		});
		await until(() => peerCloses.some(close => close.code === 4007), "peer observed its close");

		const localCloseClient = socket(`ws://127.0.0.1:${proxyServer.port}`, "/peers/vps/r/session-b?role=guest");
		await waitOpen(localCloseClient);
		expect(await waitText(localCloseClient, "second peer greeting")).toBe("peer greeting");
		await waitBinary(localCloseClient, "second peer binary greeting");
		const localClose = waitEvent<CloseEvent>(localCloseClient, "close", "client close propagation");
		localCloseClient.close(4008, "client close");
		expect((await localClose).code).toBe(4008);
		await until(() => peerCloses.some(close => close.code === 4008), "peer observed the client close");
		expect(peerCloses.find(close => close.code === 4008)).toEqual({ code: 4008, reason: "client close" });
		const failedClient = socket(`ws://127.0.0.1:${proxyServer.port}`, "/peers/vps/r/session-c?role=guest");
		await waitOpen(failedClient);
		await waitText(failedClient, "third peer greeting");
		await waitBinary(failedClient, "third peer binary greeting");
		const errorClose = waitEvent<CloseEvent>(failedClient, "close", "abnormal peer closure");
		failedClient.send("terminate-from-peer");
		expect((await errorClose).code).toBe(1011);
	});

	it("carries a frame large enough to hit backpressure (a session snapshot) and keeps the bridge open", async () => {
		const big = new Uint8Array(900 * 1024).fill(7);
		websocketPeerServer = Bun.serve<{ connected: true }>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req, server) {
				return server.upgrade(req, { data: { connected: true } }) ? undefined : new Response("upgrade", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.send(big);
					socket.send("after the big frame");
				},
				message() {},
			},
		});
		const peerConfig: PeerDaemon = { ...peer, url: `http://127.0.0.1:${websocketPeerServer.port}` };
		proxyServer = Bun.serve<RelaySocketData>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req, server) {
				const response = peerRelayUpgrade(req, server, [peerConfig]);
				return response === null ? new Response("not found", { status: 404 }) : response;
			},
			websocket: peerRelayWebSocket({ message() {} }),
		});
		const client = socket(`ws://127.0.0.1:${proxyServer.port}`, "/peers/vps/r/session-big?role=guest");
		await waitOpen(client);
		expect((await waitBinary(client, "large peer frame")).byteLength).toBe(big.byteLength);
		expect(await waitText(client, "frame after the large one")).toBe("after the big frame");
		expect(client.readyState).toBe(WebSocket.OPEN);
	});
});

describe("peer proxy hardening", () => {
	it("rejects peer ids outside the daemon id grammar before forwarding", async () => {
		let calls = 0;
		const handler = createPeerRoutes({
			self,
			peers: [peer],
			fetch: async () => {
				calls++;
				return Response.json({ ok: true });
			},
			log: () => {},
		});

		const response = requireResponse(await callRoute(handler, routeRequest("/api/peers/bad_peer/health")));
		expect(response.status).toBe(400);
		expect(calls).toBe(0);
		const encodedValid = requireResponse(await callRoute(handler, routeRequest("/api/peers/%76ps/health")));
		expect(encodedValid.status).toBe(200);
		expect(calls).toBe(1);
	});

	it("rejects decoded invalid ids before upgrading a peer relay socket", async () => {
		proxyServer = Bun.serve<RelaySocketData>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req, server) {
				const response = peerRelayUpgrade(req, server, [peer]);
				return response === null ? new Response("not found", { status: 404 }) : response;
			},
			websocket: peerRelayWebSocket({ message() {} }),
		});
		const response = await fetch(`http://127.0.0.1:${proxyServer.port}/peers/%62ad_peer/r/Room_12345`);
		expect(response.status).toBe(400);
	});

	it("serves only JSON and event streams as active peer content", async () => {
		for (const contentType of ["text/html", "text/plain", "application/javascript", undefined]) {
			const handler = createPeerRoutes({
				self,
				peers: [peer],
				fetch: async () => new Response("<script>peer-controlled</script>", {
					headers: contentType === undefined ? undefined : { "content-type": contentType },
				}),
				log: () => {},
			});
			const response = requireResponse(await callRoute(handler, routeRequest("/api/peers/vps/health")));
			expect(response.headers.get("content-type")).toBe("application/octet-stream");
			expect(response.headers.get("content-disposition")).toBe("attachment");
			expect(await response.text()).toBe("<script>peer-controlled</script>");
		}

		for (const contentType of ["application/json; charset=utf-8", "text/event-stream; charset=utf-8"]) {
			const handler = createPeerRoutes({
				self,
				peers: [peer],
				fetch: async () => new Response("safe payload", { headers: { "content-type": contentType } }),
				log: () => {},
			});
			const response = requireResponse(await callRoute(handler, routeRequest("/api/peers/vps/health")));
			expect(response.headers.get("content-type")).toBe(contentType);
			expect(response.headers.get("content-disposition")).toBeNull();
		}
	});

	it("joins an existing remote host room as a guest even when the client asks for host", async () => {
		const upstreamRelay: LocalRelay = startLocalRelay();
		try {
			const room = "RemoteRole_12345";
			const host = socket(upstreamRelay.url, `/r/${room}?role=host`);
			await waitOpen(host);
			const peerConfig: PeerDaemon = {
				...peer,
				url: upstreamRelay.url.replace(/^ws:/, "http:"),
			};
			proxyServer = Bun.serve<RelaySocketData>({
				hostname: "127.0.0.1",
				port: 0,
				fetch(req, server) {
					const response = peerRelayUpgrade(req, server, [peerConfig]);
					return response === null ? new Response("not found", { status: 404 }) : response;
				},
				websocket: peerRelayWebSocket({ message() {} }),
			});

			const client = socket(`ws://127.0.0.1:${proxyServer.port}`, `/peers/vps/r/${room}?role=host`);
			await waitOpen(client);
			expect(JSON.parse(await waitText(host, "remote room guest join"))).toEqual({ t: "peer-joined", peer: 1 });
			expect(upstreamRelay.relay.guestCount).toBe(1);
			expect(host.readyState).toBe(WebSocket.OPEN);
		} finally {
			upstreamRelay.stop();
		}
	});
});

describe("peer response compression", () => {
	it("decodes compressed upstream JSON before applying one downstream encoding and leaves SSE untouched", async () => {
		const original = Buffer.from(JSON.stringify({ payload: "peer response payload ".repeat(200) }));
		const upstreamCompressed = zlib.gzipSync(original);
		httpPeerServer = Bun.serve<undefined>({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const pathname = new URL(req.url).pathname;
				if (pathname === "/api/health") return new Response(null, { status: 200 });
				if (pathname === "/api/events") {
					return new Response("event: update\ndata: ready\n\n", { headers: { "content-type": "text/event-stream" } });
				}
				return new Response(upstreamCompressed, {
					headers: {
						"content-type": "application/json; charset=utf-8",
						"content-encoding": "gzip",
						"content-length": String(upstreamCompressed.byteLength),
					},
				});
			},
		});
		const daemon = await startTestDaemon({
			features: { librarian: false, agenda: false, quickAsk: false, peers: true, openrouterDecisions: false, computerUse: false, overnight: false },
			peers: [{ ...peer, url: `http://127.0.0.1:${httpPeerServer.port}` }],
		});
		const port = Number(new URL(daemon.url).port);

		const json = await rawHttpRequest(port, "/api/peers/vps/models", { "Accept-Encoding": "gzip", Cookie: daemon.cookie });
		expect(json.status).toBe(200);
		expect(json.headers["content-encoding"]).toBe("gzip");
		expect(zlib.gunzipSync(new Uint8Array(json.body))).toEqual(original);
		if (json.headers["content-length"] !== undefined) {
			expect(Number(json.headers["content-length"])).toBe(json.body.byteLength);
		}

		const events = await rawHttpRequest(port, "/api/peers/vps/events", { "Accept-Encoding": "gzip", Cookie: daemon.cookie });
		expect(events.status).toBe(200);
		expect(events.headers["content-type"]).toContain("text/event-stream");
		expect(events.headers["content-encoding"]).toBeUndefined();
		expect(events.body.toString("utf8")).toBe("event: update\ndata: ready\n\n");
	});
});
