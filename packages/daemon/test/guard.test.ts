/**
 * Browser-reachable attacks on a loopback daemon: DNS rebinding (foreign `Host`), cross-site requests
 * (foreign `Origin`), cross-origin WebSocket upgrades, forged forwarding headers. Each refused request must
 * have no effect (no worker started, no room created) and the legitimate flows must keep working.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ListSessionsResponse, SessionSummary } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkFetchSite } from "../src/auth";
import { startDaemon } from "../src/server";
import { type TestDaemon, rawRequest, rawUpgrade, startTestDaemon, stopTestDaemons } from "./harness";
import { fakeCmd, makeTmp } from "./helpers";
import { closeAllSockets, socket, until, waitOpen, waitText } from "./ws-helpers";

afterEach(async () => {
	closeAllSockets();
	await stopTestDaemons();
});

const OWNER = "alice@example.com";
const TAILNET_HOST = "host.tailnet-example.ts.net";

function webDir(): string {
	const root = makeTmp("deck-web-");
	fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>deck</title>");
	return root;
}

function sameOrigin(t: TestDaemon): Record<string, string> {
	return { Origin: `http://127.0.0.1:${t.daemon.port}`, Cookie: t.cookie };
}

async function expectNothingStarted(t: TestDaemon): Promise<void> {
	expect(t.daemon.supervisor.list()).toHaveLength(0);
	expect(t.daemon.relay.hasRoom("RoomRebind_12345")).toBe(false);
	const body = (await (await t.get("/api/sessions")).json()) as ListSessionsResponse;
	expect(body.live).toEqual([]);
}

describe("host allowlist (DNS rebinding)", () => {
	it("refuses a foreign Host on every route with 421, even from loopback with the owner's login", async () => {
		const t = await startTestDaemon({ owner: OWNER, webDir: webDir() });
		const port = t.daemon.port;
		for (const host of [
			"evil.example",
			`evil.example:${port}`,
			`localhost.evil.example:${port}`,
			`127.0.0.1.nip.io:${port}`,
			`user@127.0.0.1:${port}`,
			`127.0.0.1:99999`,
			TAILNET_HOST, // not allowed until --allow-host names it
		]) {
			const headers = { Host: host };
			const attempts: Array<[string, Promise<Response>]> = [
				["GET /api/health", t.get("/api/health", headers)],
				["GET /api/sessions", t.get("/api/sessions", headers)],
				["POST /api/sessions", t.post("/api/sessions", { cwd: t.dir }, headers)],
				["DELETE /api/sessions/x", t.del("/api/sessions/x", headers)],
				["GET /", t.get("/", headers)],
				["GET /r", t.get("/r/RoomRebind_12345?role=host", headers)],
				["login", t.get("/api/health", { ...headers, "Tailscale-User-Login": OWNER })],
			];
			for (const [label, pending] of attempts) {
				expect({ host, label, status: (await pending).status }).toEqual({ host, label, status: 421 });
			}
			expect({ host, status: await rawUpgrade(port, "/r/RoomRebind_12345?role=host", headers) }).toEqual({ host, status: 421 });
		}
		await expectNothingStarted(t);
	});

	it("accepts every default loopback name with or without a port, any case", async () => {
		const t = await startTestDaemon({});
		const port = t.daemon.port;
		for (const host of [`127.0.0.1:${port}`, "127.0.0.1", `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, "[::1]"]) {
			expect({ host, status: (await t.get("/api/health", { Host: host })).status }).toEqual({ host, status: 200 });
		}
	});

	it("refuses a forged X-Forwarded-Host on every route, including when Host is fine and the login is the owner's", async () => {
		const t = await startTestDaemon({ owner: OWNER, webDir: webDir(), allowHosts: [TAILNET_HOST] });
		const port = t.daemon.port;
		const proxied = { "Tailscale-User-Login": OWNER, "X-Forwarded-For": "100.64.0.7", "X-Forwarded-Proto": "https" };
		for (const forwarded of ["evil.example", `${TAILNET_HOST}, evil.example`, "evil.example, " + TAILNET_HOST, "127.0.0.1@evil.example"]) {
			const headers = { ...proxied, "X-Forwarded-Host": forwarded };
			expect({ forwarded, status: (await t.get("/api/health", headers)).status }).toEqual({ forwarded, status: 421 });
			expect({ forwarded, status: (await t.post("/api/sessions", { cwd: t.dir }, headers)).status }).toEqual({ forwarded, status: 421 });
			expect({ forwarded, status: (await t.get("/", headers)).status }).toEqual({ forwarded, status: 421 });
			expect({ forwarded, status: await rawUpgrade(port, "/r/RoomRebind_12345?role=guest", headers) }).toEqual({ forwarded, status: 421 });
		}
		expect((await t.get("/api/health", { ...proxied, "X-Forwarded-Host": TAILNET_HOST })).status).toBe(200);
		await expectNothingStarted(t);
	});

	it("--allow-host names are accepted (case-insensitive, port ignored) and everything else stays refused", async () => {
		const t = await startTestDaemon({ allowHosts: [TAILNET_HOST.toUpperCase(), "deck.local:8443"] });
		const port = t.daemon.port;
		for (const host of [TAILNET_HOST, `${TAILNET_HOST}:${port}`, "deck.local", "deck.local:1"]) {
			expect({ host, status: (await t.get("/api/health", { Host: host })).status }).toEqual({ host, status: 200 });
		}
		expect((await t.get("/api/health", { Host: "other.ts.net" })).status).toBe(421);
		expect((await t.get("/api/health", { Host: `x.${TAILNET_HOST}` })).status).toBe(421);
	});

	it("rejects malformed --allow-host values instead of widening the policy", async () => {
		for (const bad of ["*.ts.net", "https://mac.ts.net", "mac.ts.net/path", "::1", "", "a b", "mac@ts.net"]) {
			const dir = makeTmp("deck-state-");
			const started = startDaemon({ port: 0, stateDir: dir, workerCmd: fakeCmd(), listRecent: async () => [], allowHosts: [bad] });
			await expect(started).rejects.toThrow(/invalid allowed host/);
		}
	});
});

describe("origin check (cross-site requests)", () => {
	it("refuses a foreign Origin on every method and route with 403, and nothing happens", async () => {
		const t = await startTestDaemon({ webDir: webDir() });
		for (const origin of ["https://evil.example", "http://evil.example:7481", "null", "http://127.0.0.1.evil.example", "https://localhost@evil.example"]) {
			const headers = { Origin: origin };
			const attempts: Array<[string, Promise<Response>]> = [
				["POST /api/sessions", t.post("/api/sessions", { cwd: t.dir }, headers)],
				["POST text/plain (no preflight)", t.post("/api/sessions", JSON.stringify({ cwd: t.dir }), { ...headers, "Content-Type": "text/plain" })],
				["POST /api/push/subscribe", t.post("/api/push/subscribe", {}, headers)],
				["DELETE /api/sessions/x", t.del("/api/sessions/x", headers)],
				["GET /api/sessions", t.get("/api/sessions", headers)],
				["GET /", t.get("/", headers)],
				["OPTIONS preflight", fetch(`${t.url}/api/sessions`, { method: "OPTIONS", headers: { ...headers, Cookie: t.cookie, "Access-Control-Request-Method": "POST" } })],
			];
			for (const [label, pending] of attempts) {
				const res = await pending;
				expect({ origin, label, status: res.status }).toEqual({ origin, label, status: 403 });
				// No CORS grant: the attacker page could not read it either.
				expect(res.headers.get("access-control-allow-origin")).toBeNull();
			}
		}
		await expectNothingStarted(t);
	});

	it("requires the origin to equal the effective host, port included", async () => {
		const t = await startTestDaemon({});
		const port = t.daemon.port;
		const cases: Array<[string, Record<string, string>, number]> = [
			["same origin", { Origin: `http://127.0.0.1:${port}` }, 200],
			["localhost origin against 127.0.0.1 host", { Origin: `http://localhost:${port}` }, 403],
			["allowed name on another port (a local dev server)", { Origin: "http://localhost:3000" }, 403],
			["allowed IP on another port", { Origin: "http://127.0.0.1:9999" }, 403],
			["same host without a port", { Origin: "http://127.0.0.1" }, 403],
			["localhost origin against localhost host", { Host: `localhost:${port}`, Origin: `http://localhost:${port}` }, 200],
			["IPv6 origin against IPv6 host", { Host: `[::1]:${port}`, Origin: `http://[::1]:${port}` }, 200],
			["https scheme on the same port is the same host and port", { Origin: `https://127.0.0.1:${port}` }, 200],
		];
		for (const [label, headers, status] of cases) {
			expect({ label, status: (await t.get("/api/health", headers)).status }).toEqual({ label, status });
		}
	});

	it("through tailscale serve the origin must equal X-Forwarded-Host and the owner must be logged in", async () => {
		const t = await startTestDaemon({ owner: OWNER, webDir: webDir(), allowHosts: [TAILNET_HOST] });
		const serve = { "Tailscale-User-Login": OWNER, "X-Forwarded-For": "100.64.0.7", "X-Forwarded-Proto": "https", "X-Forwarded-Host": TAILNET_HOST };
		const cases: Array<[string, Record<string, string>, number]> = [
			["same origin", { Origin: `https://${TAILNET_HOST}` }, 200],
			["no origin", {}, 200],
			["foreign origin", { Origin: "https://evil.example" }, 403],
			["other port", { Origin: `https://${TAILNET_HOST}:8443` }, 403],
			["http downgrade is another port", { Origin: `http://${TAILNET_HOST}` }, 403],
			["loopback origin against the tailnet host", { Origin: "http://127.0.0.1:7481" }, 403],
			["wrong login", { Origin: `https://${TAILNET_HOST}`, "Tailscale-User-Login": "mallory@example.com" }, 401],
		];
		for (const [label, extra, status] of cases) {
			const res = await t.get("/api/health", { ...serve, ...extra });
			expect({ label, status: res.status }).toEqual({ label, status });
		}
		const created = await t.post("/api/sessions", { cwd: t.dir }, { ...serve, Origin: `https://${TAILNET_HOST}` });
		expect(created.status).toBe(201);
		const cross = await t.post("/api/sessions", { cwd: t.dir }, { ...serve, Origin: "https://evil.example" });
		expect(cross.status).toBe(403);
		expect(t.daemon.supervisor.list()).toHaveLength(1);
	});
});

describe("WebSocket upgrades", () => {
	it("refuses cross-origin upgrades in both roles and creates no room; same-origin and origin-less upgrades work", async () => {
		const t = await startTestDaemon({});
		const port = t.daemon.port;
		const ws = `ws://127.0.0.1:${port}`;
		for (const role of ["host", "guest"]) {
			for (const origin of ["https://evil.example", "http://localhost:3000", "null"]) {
				const status = await rawUpgrade(port, `/r/RoomRebind_12345?role=${role}`, { Origin: origin, Cookie: t.cookie });
				expect({ role, origin, status }).toEqual({ role, origin, status: 403 });
			}
			expect({
				role,
				status: await rawUpgrade(port, `/r/RoomRebind_12345?role=${role}`, { Host: "evil.example", Cookie: t.cookie }),
			}).toEqual({ role, status: 421 });
		}
		expect(t.daemon.relay.hasRoom("RoomRebind_12345")).toBe(false);

		// A same-origin browser host and guest, and an origin-less (worker-style) guest, all relay normally.
		const host = socket(ws, "/r/RoomSame_123456?role=host", sameOrigin(t));
		await waitOpen(host);
		const browserGuest = socket(ws, "/r/RoomSame_123456?role=guest", sameOrigin(t));
		await waitOpen(browserGuest);
		expect(JSON.parse(await waitText(host, "browser guest join"))).toEqual({ t: "peer-joined", peer: 1 });
		const plainGuest = socket(ws, "/r/RoomSame_123456?role=guest", { Cookie: t.cookie });
		await waitOpen(plainGuest);
		expect(JSON.parse(await waitText(host, "plain guest join"))).toEqual({ t: "peer-joined", peer: 2 });
		await until(() => t.daemon.relay.guestCount === 2, "two guests counted");
	});
});

describe("same-origin flows keep working", () => {
	it("serves the API, static files and the room link with a same-origin Origin header", async () => {
		const t = await startTestDaemon({ webDir: webDir() });
		const origin = sameOrigin(t);
		expect((await t.get("/api/health", origin)).status).toBe(200);
		const page = await t.get("/", origin);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("<title>deck</title>");
		const created = await t.post("/api/sessions", { cwd: t.dir }, origin);
		expect(created.status).toBe(201);
		const session = (await created.json()) as SessionSummary;
		const room = await t.post(`/api/sessions/${session.id}/room`, { permission: "view" }, origin);
		expect(room.status).toBe(200);
		expect((await t.del(`/api/sessions/${session.id}`, origin)).status).toBe(204);
	});
});

describe("Sec-Fetch-Site request guard", () => {
	it("blocks cross-site and same-site APIs and relay upgrades, while allowing trusted fetch contexts", () => {
		for (const site of ["cross-site", "same-site"]) {
			const headers = new Headers({ "sec-fetch-site": site });
			expect(checkFetchSite(headers, "/api/health")).toEqual({ status: 403, message: "fetch site not allowed" });
			expect(checkFetchSite(headers, "/api")).toEqual({ status: 403, message: "fetch site not allowed" });
			const upgradeHeaders = new Headers(headers);
			upgradeHeaders.set("upgrade", "websocket");
			expect(checkFetchSite(upgradeHeaders, "/r/FetchSiteRoom_12345")).toEqual({ status: 403, message: "fetch site not allowed" });
			expect(checkFetchSite(upgradeHeaders, "/peers/vps/r/FetchSiteRoom_12345")).toEqual({ status: 403, message: "fetch site not allowed" });
		}
		for (const site of ["same-origin", "none", undefined]) {
			const headers = site === undefined ? new Headers() : new Headers({ "sec-fetch-site": site });
			expect(checkFetchSite(headers, "/api/health")).toBeNull();
			const upgradeHeaders = new Headers(headers);
			upgradeHeaders.set("upgrade", "websocket");
			expect(checkFetchSite(upgradeHeaders, "/r/FetchSiteRoom_12345")).toBeNull();
			expect(checkFetchSite(upgradeHeaders, "/peers/vps/r/FetchSiteRoom_12345")).toBeNull();
		}
		expect(checkFetchSite(new Headers({ "sec-fetch-site": "cross-site" }), "/apiary")).toBeNull();
	});

	it("keeps an encoded dot-segment peer path on the local health route", async () => {
		const t = await startTestDaemon({});
		const local = await t.get("/api/health").then(response => response.json());
		const response = await rawRequest(t.daemon.port, "/api/peers/%2e%2e/health", "GET", { Cookie: t.cookie });
		expect(response.status).toBe(200);
		const body = response.text.slice(response.text.indexOf("\r\n\r\n") + 4);
		expect(JSON.parse(body)).toEqual(local);
	});
});
